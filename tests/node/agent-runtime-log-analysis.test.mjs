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
    '[1785135800.075] [info] [store.runtime_v2_context_prepared] {"turnId":"turn-v2","runId":"run-v2","mode":"execute","executePolicy":"mutation_required","mutationToolAvailable":true,"sourceReadAvailable":false,"providerActionWindow":"corrective_mutation","mutationLeaseAuthority":"acceptance_failure","excludedMutationTool":"apply_patch","availableContextEntries":16,"droppedEvidenceEntries":4,"contextSources":{"workspace":1,"tool":12,"subagent":2,"provider":1,"plan":0},"retainedContextSources":{"workspace":1,"tool":3,"subagent":2,"provider":1,"plan":0}}',
    '[1785135800.076] [warn] [store.runtime_v2_context_prepared] {"turnId":"turn-v2","runId":"run-v2","mode":"observe","mutationToolAvailable":true}',
    '[1785135800.077] [warn] [store.runtime_v2_context_prepared] {"turnId":"turn-v2","runId":"run-v2","mode":"execute","executePolicy":"source_gap_allowed","mutationToolAvailable":true}',
    '[1785135800.078] [warn] [store.runtime_v2_context_prepared] {"turnId":"turn-v2","runId":"run-v2","mode":"execute","executePolicy":"mutation_required","mutationToolAvailable":true}',
    '[1785135800.100] [info] [store.runtime_v2_tool_execution_started] {"turnId":"turn-v2","runId":"run-v2","toolName":"read_file","target":"src/main.js"}',
    '[1785135800.150] [info] [store.runtime_v2_subagent_context_handoff] {"turnId":"turn-v2","runId":"run-v2","jobId":"child-a","inheritedContext":true,"parentContextChars":2400}',
    '[1785135800.200] [info] [store.runtime_v2_subagent_request_opened] {"turnId":"turn-v2","runId":"run-v2","jobId":"child-a"}',
    '[1785135800.250] [info] [store.runtime_v2_subagent_auto_join] {"turnId":"turn-v2","runId":"run-v2","jobIds":["child-a"],"reason":"parent_closed_action_while_children_active"}',
    '[1785135800.275] [info] [store.runtime_v2_subagent_closed_observation_loop] {"turnId":"turn-v2","runId":"run-v2","jobId":"child-a","evidenceCount":1}',
    '[1785135800.300] [info] [store.runtime_v2_subagent_joined] {"turnId":"turn-v2","runId":"run-v2","jobId":"child-a","status":"completed","structuredReport":false}',
    '[1785135800.400] [info] [store.runtime_v2_phase_transition] {"turnId":"turn-v2","runId":"run-v2","from":"observing","to":"acting"}',
    '[1785135800.500] [info] [store.runtime_v2_projection_published] {"turnId":"turn-v2","runId":"run-v2","audience":"capsule_live","storeDisposition":"projected"}',
    '[1785135800.600] [info] [store.runtime_v2_tool_execution_started] {"turnId":"turn-v2","runId":"run-v2","toolName":"apply_patch","target":"src/main.js"}',
    '[1785135800.650] [info] [store.runtime_v2_mutation_preflight_rejected] {"turnId":"turn-v2","runId":"run-v2","toolName":"apply_patch","target":"src/main.js","reason":"oversized_change"}',
    '[1785135800.660] [info] [store.runtime_v2_mutation_preflight_rejected] {"turnId":"turn-v2","runId":"run-v2","toolName":"write_file","target":"/tmp/outside.js","reason":"outside_workspace"}',
    '[1785135800.700] [info] [store.runtime_v2_ledger_committed] {"turnId":"turn-v2","runId":"run-v2","eventType":"soft_signal.observed"}',
    '[1785135800.710] [info] [store.runtime_v2_ledger_committed] {"turnId":"turn-v2","runId":"run-v2","eventType":"soft_signal.observed","signal":"protocol_drift"}',
    '[1785135800.715] [warn] [store.runtime_v2_ledger_committed] {"turnId":"turn-v2","runId":"run-v2","eventType":"recovery.exhausted","recoveryScope":"diagnostic"}',
    '[1785135800.725] [info] [store.runtime_v2_tool_execution_blocked] {"turnId":"turn-v2","runId":"run-v2","commandKind":"execute_validation","toolName":"run_command","reason":"finite_validation_contract_required"}',
    '[1785135800.730] [info] [store.runtime_v2_tool_execution_blocked] {"turnId":"turn-v2","runId":"run-v2","commandKind":"execute_tool","toolName":"replace_in_file","reason":"mutation_target_lease_mismatch"}',
    '[1785135800.735] [info] [store.runtime_v2_tool_execution_blocked] {"turnId":"turn-v2","runId":"run-v2","commandKind":"execute_tool","toolName":"replace_in_file","reason":"mutation_source_text_mismatch"}',
    '[1785135800.750] [info] [store.runtime_v2_tool_execution_completed] {"turnId":"turn-v2","runId":"run-v2","commandKind":"execute_validation","toolName":"run_command","validationPassed":true}',
    '[1785135800.800] [info] [store.runtime_v2_execute_terminal] {"turnId":"turn-v2","runId":"run-v2","resultKind":"success","reason":"validated","mutations":1,"verificationComplete":true,"staticOnlyBehavioralCriterionIds":["criterion-visible-behavior"]}',
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
  assert.equal(report.runs[0].subagentContextHandoffs, 1);
  assert.equal(report.runs[0].subagentAutoJoins, 1);
  assert.equal(report.runs[0].subagentClosedObservationLoops, 1);
  assert.equal(report.runs[0].providerActionWindows, 1);
  assert.equal(report.runs[0].correctiveMutationActionWindows, 1);
  assert.equal(report.runs[0].closedRecoveryActionWindows, 0);
  assert.equal(report.runs[0].subagentsJoined, 1);
  assert.equal(report.runs[0].completedSubagentsWithoutReport, 1);
  assert.equal(report.runs[0].softSignals, 2);
  assert.equal(report.runs[0].protocolDriftSignals, 1);
  assert.equal(report.runs[0].recoveryExhaustions, 1);
  assert.equal(report.runs[0].actionRecoveryExhaustions, 1);
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
  assert.equal(report.runs[0].mutationSourceTextMismatches, 1);
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
  assert.deepEqual(report.runs[0].warnings, [
    "completed_subagent_without_structured_report",
    "protocol_drift_caused_action_terminal",
    "static_validation_claims_behavior_coverage",
    "safe_read_batch_discarded",
  ]);
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
  assert.equal(report.aggregate.mutationSourceTextMismatches, 1);
  assert.equal(report.aggregate.subagentAutoJoins, 1);
  assert.equal(report.aggregate.subagentClosedObservationLoops, 1);
  assert.equal(report.aggregate.providerActionWindows, 1);
  assert.equal(report.aggregate.correctiveMutationActionWindows, 1);
  assert.equal(report.aggregate.closedRecoveryActionWindows, 0);
  assert.equal(report.aggregate.investigationMutationSurfaceViolations, 1);
  assert.equal(report.aggregate.sourceGapMutationSurfaceViolations, 1);
  assert.equal(report.aggregate.mutationRequestsWithoutLease, 1);
  assert.equal(report.aggregate.mutationEditorFallbacks, 1);
  assert.equal(report.aggregate.totalWarnings, 4);
  assert.deepEqual(report.aggregate.warningCounts, {
    completed_subagent_without_structured_report: 1,
    protocol_drift_caused_action_terminal: 1,
    static_validation_claims_behavior_coverage: 1,
    safe_read_batch_discarded: 1,
  });
});

test("latest child handoff incident detects discarded work and false transport exhaustion", () => {
  const runId = "run-child-handoff";
  const childRunId =
    `${runId}:child:runtime-v2-child:ms47dtia:82`;
  const turnId = "turn-child-handoff";
  const report = analyzeAgentRuntimeEvents(parseAgentRuntimeLog([
    `[1785215721.000] [info] [store.runtime_v2_execute_admitted] {"turnId":"${turnId}","runId":"${runId}","strategy":"execute"}`,
    `[1785215722.000] [info] [store.runtime_v2_provider_request_opened] {"turnId":"${turnId}","runId":"${runId}","phase":"observing"}`,
    `[1785215723.000] [info] [store.runtime_v2_subagent_request_opened] {"turnId":"${turnId}","runId":"${runId}","jobId":"runtime-v2-child:ms47dtia:82"}`,
    `[1785215724.000] [info] [store.runtime_v2_subagent_provider_result] {"turnId":"${turnId}","runId":"${childRunId}","jobId":"runtime-v2-child:ms47dtia:82","toolName":"read_file"}`,
    `[1785215725.000] [info] [store.runtime_v2_subagent_provider_result] {"turnId":"${turnId}","runId":"${childRunId}","jobId":"runtime-v2-child:ms47dtia:82","toolName":"grep_search"}`,
    `[1785215726.000] [info] [store.runtime_v2_subagent_joined] {"turnId":"${turnId}","runId":"${runId}","jobId":"runtime-v2-child:ms47dtia:82","status":"failed","structuredReport":false,"evidenceTargets":[]}`,
    `[1785215727.000] [info] [store.runtime_v2_ledger_committed] {"turnId":"${turnId}","runId":"${runId}","eventType":"recovery.exhausted","recoveryScope":"transport"}`,
    `[1785215728.000] [info] [store.runtime_v2_execute_terminal] {"turnId":"${turnId}","runId":"${runId}","resultKind":"error","reason":"provider_transport_exhausted","mutations":0,"verificationComplete":false}`,
  ].join("\n")));
  const parent = report.runs.find((run) => run.runId === runId);

  assert.equal(parent.subagentProviderActions, 2);
  assert.equal(parent.failedSubagentsWithoutEvidence, 1);
  assert.equal(parent.providerRequestsAfterFailedSubagentJoin, 0);
  assert.deepEqual(parent.warnings, [
    "subagent_started_without_parent_context_handoff",
    "failed_subagent_discarded_tool_evidence",
    "parent_did_not_resume_after_subagent_failure",
    "non_provider_failure_marked_transport_exhaustion",
  ]);
});

test("latest no-mutation replay identifies discarded safe reads and provider livelock", () => {
  const turnId = "turn-latest-no-mutation";
  const runId = "run-latest-no-mutation";
  const lines = [
    `[1785314679.000] [info] [store.runtime_v2_execute_admitted] {"turnId":"${turnId}","runId":"${runId}","strategy":"execute"}`,
    `[1785314680.000] [info] [store.runtime_v2_provider_request_opened] {"turnId":"${turnId}","runId":"${runId}","transport":"native_required"}`,
    `[1785314681.000] [info] [store.runtime_v2_provider_tool_batch_normalized] {"turnId":"${turnId}","runId":"${runId}","acceptedToolName":"read_file","discardedToolNames":["read_file","get_file_outline"]}`,
    `[1785314682.000] [info] [store.runtime_v2_context_prepared] {"turnId":"${turnId}","runId":"${runId}","approximateMessageChars":105000}`,
  ];
  for (let index = 0; index < 4; index += 1) {
    lines.push(
      `[17853146${83 + index}.000] [info] [store.runtime_v2_provider_request_opened] {"turnId":"${turnId}","runId":"${runId}","transport":"native_required"}`,
      `[17853146${83 + index}.500] [info] [store.runtime_v2_provider_action_rejected] {"turnId":"${turnId}","runId":"${runId}","toolName":"replace_in_file","reason":"already_rejected"}`,
      `[17853146${83 + index}.700] [info] [store.runtime_v2_context_prepared] {"turnId":"${turnId}","runId":"${runId}","approximateMessageChars":105000}`,
    );
  }
  lines.push(
    `[1785314688.000] [info] [store.runtime_v2_tool_execution_started] {"turnId":"${turnId}","runId":"${runId}","toolName":"replace_in_file","target":"src/main.js"}`,
    `[1785314689.000] [info] [store.runtime_v2_tool_execution_started] {"turnId":"${turnId}","runId":"${runId}","toolName":"apply_patch","target":"src/main.js"}`,
    `[1785314690.000] [warn] [store.runtime_v2_provider_transport_failed] {"turnId":"${turnId}","runId":"${runId}","error":"RUNTIME_V2_EXECUTION_PROVIDER_REQUEST_TIMEOUT"}`,
    `[1785314691.000] [info] [store.runtime_v2_execute_terminal] {"turnId":"${turnId}","runId":"${runId}","resultKind":"error","mutations":0,"verificationComplete":false}`,
  );

  const report = analyzeAgentRuntimeEvents(
    parseAgentRuntimeLog(lines.join("\n")),
  );
  const run = report.runs[0];

  assert.equal(run.providerRequestTimeouts, 1);
  assert.equal(run.providerActionRejections, 4);
  assert.equal(run.mutationToolCalls, 2);
  assert.equal(run.committedMutations, 0);
  assert.equal(run.maxStrategyPivotRevision, 0);
  assert.deepEqual(run.warnings, [
    "safe_read_batch_discarded",
    "provider_livelock_without_strategy_pivot",
    "provider_repeated_actions_without_effect",
  ]);
});

test("provider recovery stall is diagnosed without treating ordinary Execute time as a deadline", () => {
  const turnId = "turn-provider-recovery-stall";
  const runId = "run-provider-recovery-stall";
  const report = analyzeAgentRuntimeEvents(parseAgentRuntimeLog([
    `[1785411088.000] [info] [store.runtime_v2_execute_admitted] {"turnId":"${turnId}","runId":"${runId}","strategy":"execute"}`,
    `[1785411101.000] [info] [store.runtime_v2_provider_request_opened] {"turnId":"${turnId}","runId":"${runId}","phase":"observing"}`,
    `[1785411101.100] [info] [store.runtime_v2_context_prepared] {"turnId":"${turnId}","runId":"${runId}","mode":"execute","sourceOnlyFrontier":true,"mutationToolAvailable":true}`,
    `[1785411102.000] [info] [store.runtime_v2_tool_execution_started] {"turnId":"${turnId}","runId":"${runId}","toolName":"read_file","target":"src/main.js"}`,
    `[1785411165.000] [info] [store.runtime_v2_provider_request_opened] {"turnId":"${turnId}","runId":"${runId}","phase":"observing"}`,
    `[1785411165.100] [info] [store.runtime_v2_context_prepared] {"turnId":"${turnId}","runId":"${runId}","mode":"execute","sourceOnlyFrontier":true,"mutationToolAvailable":true}`,
    `[1785411166.000] [info] [store.runtime_v2_tool_execution_started] {"turnId":"${turnId}","runId":"${runId}","toolName":"grep_search","target":"writeFile"}`,
    `[1785411167.000] [info] [store.runtime_v2_provider_action_rejected] {"turnId":"${turnId}","runId":"${runId}","toolName":"replace_in_file","reason":"already_rejected"}`,
    `[1785411168.000] [info] [store.runtime_v2_context_prepared] {"turnId":"${turnId}","runId":"${runId}","mode":"execute","recoveryStage":"reconsider","recoveryOccurrence":1}`,
    `[1785411169.000] [info] [store.runtime_v2_provider_action_rejected] {"turnId":"${turnId}","runId":"${runId}","toolName":"replace_in_file","reason":"already_rejected"}`,
    `[1785411170.000] [info] [store.runtime_v2_context_prepared] {"turnId":"${turnId}","runId":"${runId}","mode":"execute","recoveryStage":"reframe","recoveryOccurrence":2}`,
    `[1785411688.000] [info] [store.runtime_v2_provider_recovery_stall_reached] {"turnId":"${turnId}","runId":"${runId}","phase":"observing","reason":"repeated_action_rejected","occurrence":2}`,
    `[1785411690.000] [info] [store.runtime_v2_execute_terminal] {"turnId":"${turnId}","runId":"${runId}","resultKind":"error","reason":"模型恢复已连续停滞。","mutations":0,"verificationComplete":false}`,
  ].join("\n")));
  const run = report.runs[0];

  assert.equal(run.providerProtocolFailures, 0);
  assert.equal(run.providerTransportFailures, 0);
  assert.equal(run.sourceOnlyFrontierContexts, 2);
  assert.equal(run.lifecycleDeadlineClosures, 0);
  assert.equal(run.providerRecoveryStallClosures, 1);
  assert.equal(run.maxProviderRecoveryOccurrence, 2);
  assert.deepEqual(run.warnings, [
    "source_only_frontier_ended_without_effect",
  ]);
});
