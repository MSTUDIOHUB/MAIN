#!/usr/bin/env node

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const READ_FILE_TOOL_NAMES = new Set([
  "read_file",
]);

export const MUTATION_TOOL_NAMES = new Set([
  "apply_patch",
  "replace_in_file",
  "write_file",
]);

export const VALIDATION_TOOL_NAMES = new Set([
  "browser_evaluate",
  "execute_command",
  "get_pty_status",
  "read_pty_buffer",
  "read_pty_since",
  "read_pty_tail",
  "run_command",
  "send_pty_input",
]);

const NO_ACTION_STOP_REASONS = new Set([
  "approved_plan_completion_guard",
  "approved_plan_completion_guard_no_evidence",
  "approved_plan_read_file_repeat_limit",
  "approved_plan_reasoning_length_no_action",
  "approved_plan_repeated_browser_validation",
  "approved_plan_repeated_read_file",
  "empty_model_response",
  "execute_completion_claim_without_evidence",
  "execute_no_progress_batch_loop",
  "execute_read_only_no_action_checkpoint",
  "execute_replanning_text_without_evidence",
  "execute_xml_text_without_action",
  "execution_evidence_required",
  "force_plan_continuation_limit",
  "max_iterations_boundary",
  "missing_tool_reprompt_limit",
  "no_progress_batch_loop",
  "no_progress_cached_read_only_length",
  "plan_empty_response_checkpoint",
  "plan_execution_no_tool_checkpoint",
  "plan_recovery_prompt_limit",
  "plan_refine_long_output_limit",
  "read_file_repeat_limit_batch",
  "remaining_plan_tasks_limit",
  "repeat_edit_target_without_validation",
]);

const LOG_LINE_PATTERN = /^\s*\[([^\]]+)\]\s+\[([^\]]+)\]\s+\[([^\]]+)\]\s+(.+?)\s*$/;

function asString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function asNonNegativeInteger(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.trunc(number) : 0;
}

function incrementCounter(counter, key, amount = 1) {
  counter[key] = (counter[key] || 0) + amount;
}

export function parseAgentRuntimeLogLine(line) {
  const match = String(line).match(LOG_LINE_PATTERN);
  if (!match) return null;

  try {
    const payload = JSON.parse(match[4]);
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      return null;
    }
    return {
      timestamp: match[1],
      level: match[2],
      event: match[3],
      payload,
    };
  } catch {
    return null;
  }
}

export function parseAgentRuntimeLog(logText) {
  return String(logText)
    .split(/\r?\n/)
    .map(parseAgentRuntimeLogLine)
    .filter(Boolean);
}

function createRun(event, runIndex) {
  const { payload } = event;
  const runtimeVersion = event.event.startsWith("store.runtime_v2_")
    ? "v2"
    : "v1";
  return {
    runIndex,
    runtimeVersion,
    runId: asString(payload.runId),
    turnId: asString(payload.turnId),
    startedAt: event.timestamp,
    endedAt: event.timestamp,
    workflowMode: asString(payload.workflowMode) || asString(payload.strategy),
    runtimeIntent: asString(payload.runtimeIntent) || asString(payload.strategy),
    iterationLimit: asNonNegativeInteger(payload.maxIterations),
    maxIteration: 0,
    providerRequests: 0,
    providerProtocolFailures: 0,
    providerTransportFailures: 0,
    providerRequestTimeouts: 0,
    toolDeadlineExceeded: 0,
    totalToolCalls: 0,
    unclassifiedToolCalls: 0,
    readFileCalls: 0,
    mutationToolCalls: 0,
    validationToolCalls: 0,
    firstMutationIteration: null,
    noActionStops: 0,
    providerCompatibilityRetries: 0,
    contextPacks: 0,
    forcedContextPacks: 0,
    actualDroppedMessages: 0,
    subagentRequests: 0,
    subagentsJoined: 0,
    recoveryExhaustions: 0,
    softSignals: 0,
    validationPasses: 0,
    validationFailures: 0,
    invalidValidationAttempts: 0,
    validationFallbacks: 0,
    failureReadWindows: 0,
    sourceMismatchRefreshes: 0,
    runtimeOwnedSourceRefreshes: 0,
    normalizedToolBatches: 0,
    discardedToolCalls: 0,
    mutationPreflightRejections: 0,
    oversizedMutationRejections: 0,
    outsideWorkspaceMutationRejections: 0,
    correctiveTargetRejections: 0,
    investigationMutationSurfaceViolations: 0,
    sourceGapMutationSurfaceViolations: 0,
    mutationRequestsWithoutLease: 0,
    mutationEditorFallbacks: 0,
    maxAvailableContextEntries: 0,
    maxDroppedContextEntries: 0,
    contextAnchorLosses: 0,
    terminalResultKind: null,
    terminalReason: null,
    toolCallsByName: {},
    stopReasons: {},
    forcedContextReasons: {},
    executePolicies: {},
    mutationLeaseAuthorities: {},
    phaseTransitions: {},
    projections: {},
    eventCount: 0,
  };
}

function extractToolNames(payload) {
  const names = Array.isArray(payload.names)
    ? payload.names
    : Array.isArray(payload.toolNames)
      ? payload.toolNames
      : [];
  return names
    .filter((name) => typeof name === "string" && name.trim())
    .map((name) => name.trim());
}

function isNoActionStop(event) {
  if (event.event === "agent.stopped_no_action") return true;
  if (event.event === "store.non_actionable_stop") {
    const reason = asString(event.payload.reason);
    const recoveryReason = asString(event.payload.recoveryReason);
    return reason === "no_action" ||
      NO_ACTION_STOP_REASONS.has(recoveryReason) ||
      NO_ACTION_STOP_REASONS.has(reason);
  }
  return false;
}

function isRuntimeMetricEvent(event) {
  return event.event.startsWith("agent.") ||
    event.event === "store.non_actionable_stop" ||
    event.event.startsWith("store.runtime_v2_");
}

function recordToolName(run, name, iteration) {
  if (!name) {
    run.unclassifiedToolCalls += 1;
    return;
  }
  incrementCounter(run.toolCallsByName, name);
  if (READ_FILE_TOOL_NAMES.has(name)) run.readFileCalls += 1;
  if (MUTATION_TOOL_NAMES.has(name)) {
    run.mutationToolCalls += 1;
    if (run.firstMutationIteration === null && iteration > 0) {
      run.firstMutationIteration = iteration;
    }
  }
  if (VALIDATION_TOOL_NAMES.has(name)) run.validationToolCalls += 1;
}

function applyEventToRun(run, event) {
  const { payload } = event;
  run.endedAt = event.timestamp;
  run.eventCount += 1;
  run.maxIteration = Math.max(run.maxIteration, asNonNegativeInteger(payload.iteration));

  if (event.event === "agent.tool_calls_detected") {
    const names = extractToolNames(payload);
    const reportedCount = asNonNegativeInteger(payload.count);
    run.totalToolCalls += Math.max(reportedCount, names.length);
    run.unclassifiedToolCalls += Math.max(0, reportedCount - names.length);

    for (const name of names) {
      recordToolName(run, name, asNonNegativeInteger(payload.iteration));
    }
  }

  if (event.event === "store.runtime_v2_provider_request_opened") {
    run.providerRequests += 1;
    run.maxIteration = Math.max(run.maxIteration, run.providerRequests);
  }
  if (event.event === "store.runtime_v2_provider_protocol_failed") {
    run.providerProtocolFailures += 1;
    if (payload.protocolCode === "tool_arguments_rejected") {
      run.invalidValidationAttempts += 1;
    }
  }
  if (event.event === "store.runtime_v2_provider_transport_failed") {
    run.providerTransportFailures += 1;
    if (payload.timedOut === true) run.providerRequestTimeouts += 1;
  }
  if (event.event === "store.runtime_v2_tool_deadline_exceeded") {
    run.toolDeadlineExceeded += 1;
  }
  if (event.event === "store.runtime_v2_context_prepared") {
    run.maxAvailableContextEntries = Math.max(
      run.maxAvailableContextEntries,
      asNonNegativeInteger(payload.availableContextEntries),
    );
    run.maxDroppedContextEntries = Math.max(
      run.maxDroppedContextEntries,
      asNonNegativeInteger(payload.droppedEvidenceEntries),
    );
    const available = payload.contextSources &&
      typeof payload.contextSources === "object"
      ? payload.contextSources
      : {};
    const hasRetainedSources = payload.retainedContextSources &&
      typeof payload.retainedContextSources === "object";
    if (hasRetainedSources) {
      const retained = payload.retainedContextSources;
      for (const source of ["workspace", "subagent", "plan"]) {
        if (
          asNonNegativeInteger(available[source]) > 0 &&
          asNonNegativeInteger(retained[source]) === 0
        ) {
          run.contextAnchorLosses += 1;
        }
      }
    }
    const mode = asString(payload.mode);
    const executePolicy = asString(payload.executePolicy);
    if (executePolicy) incrementCounter(run.executePolicies, executePolicy);
    if (mode === "observe" && payload.mutationToolAvailable === true) {
      run.investigationMutationSurfaceViolations += 1;
    }
    if (
      executePolicy === "source_gap_allowed" &&
      payload.mutationToolAvailable === true
    ) {
      run.sourceGapMutationSurfaceViolations += 1;
    }
    const leaseAuthority = asString(payload.mutationLeaseAuthority);
    if (leaseAuthority) {
      incrementCounter(run.mutationLeaseAuthorities, leaseAuthority);
    }
    if (
      executePolicy === "mutation_required" &&
      payload.mutationToolAvailable === true &&
      !leaseAuthority &&
      run.workflowMode !== "plan"
    ) {
      run.mutationRequestsWithoutLease += 1;
    }
    if (asString(payload.excludedMutationTool)) {
      run.mutationEditorFallbacks += 1;
    }
  }

  if (event.event === "store.runtime_v2_tool_execution_started") {
    const name = asString(payload.toolName);
    run.totalToolCalls += 1;
    recordToolName(
      run,
      name,
      run.providerRequests || run.totalToolCalls,
    );
  }
  if (
    event.event === "store.runtime_v2_tool_execution_completed" &&
    payload.commandKind === "execute_validation"
  ) {
    if (payload.validationPassed === true) run.validationPasses += 1;
    else if (payload.validationPassed === false) run.validationFailures += 1;
  }
  if (
    event.event === "store.runtime_v2_tool_execution_blocked" &&
    payload.reason === "finite_validation_contract_required"
  ) {
    run.invalidValidationAttempts += 1;
  }
  if (
    event.event === "store.runtime_v2_tool_execution_blocked" &&
    (
      payload.reason === "corrective_mutation_target_mismatch" ||
      payload.reason === "mutation_target_lease_mismatch" ||
      payload.reason === "mutation_source_lease_missing"
    )
  ) {
    run.correctiveTargetRejections += 1;
  }
  if (event.event === "store.runtime_v2_validation_fallback_selected") {
    run.validationFallbacks += 1;
  }
  if (event.event === "store.runtime_v2_failure_read_window_selected") {
    run.failureReadWindows += 1;
    if (
      payload.failureLabel === "apply_patch" ||
      payload.failureLabel === "replace_in_file"
    ) {
      run.sourceMismatchRefreshes += 1;
    }
  }
  if (event.event === "store.runtime_v2_source_refresh_fallback_selected") {
    run.runtimeOwnedSourceRefreshes += 1;
  }
  if (event.event === "store.runtime_v2_provider_tool_batch_normalized") {
    run.normalizedToolBatches += 1;
    run.discardedToolCalls += Array.isArray(payload.discardedToolNames)
      ? payload.discardedToolNames.length
      : Math.max(0, asNonNegativeInteger(payload.originalToolCount) - 1);
  }
  if (event.event === "store.runtime_v2_mutation_preflight_rejected") {
    run.mutationPreflightRejections += 1;
    if (payload.reason === "oversized_change") {
      run.oversizedMutationRejections += 1;
    }
    if (payload.reason === "outside_workspace") {
      run.outsideWorkspaceMutationRejections += 1;
    }
  }

  if (event.event === "store.runtime_v2_subagent_request_opened") {
    run.subagentRequests += 1;
  }
  if (event.event === "store.runtime_v2_subagent_joined") {
    run.subagentsJoined += 1;
  }
  if (
    event.event === "store.runtime_v2_ledger_committed" &&
    payload.eventType === "recovery.exhausted"
  ) {
    run.recoveryExhaustions += 1;
  }
  if (
    event.event === "store.runtime_v2_ledger_committed" &&
    payload.eventType === "soft_signal.observed"
  ) {
    run.softSignals += 1;
  }
  if (event.event === "store.runtime_v2_phase_transition") {
    incrementCounter(
      run.phaseTransitions,
      `${asString(payload.from) || "unknown"}->${asString(payload.to) || "unknown"}`,
    );
  }
  if (event.event === "store.runtime_v2_projection_published") {
    incrementCounter(
      run.projections,
      `${asString(payload.audience) || "unknown"}:${asString(payload.storeDisposition) || "unknown"}`,
    );
  }
  if (event.event === "store.runtime_v2_execute_terminal") {
    run.terminalResultKind = asString(payload.resultKind);
    run.terminalReason = asString(payload.reason);
    incrementCounter(
      run.stopReasons,
      `runtime_v2:${run.terminalResultKind || "unknown"}`,
    );
    if (
      asNonNegativeInteger(payload.mutations) === 0 &&
      run.terminalResultKind !== "success"
    ) {
      run.noActionStops += 1;
    }
  }

  if (event.event === "agent.provider_compatibility_retry") {
    run.providerCompatibilityRetries += 1;
  }

  if (event.event === "agent.context_pack_built") {
    run.contextPacks += 1;
    run.actualDroppedMessages += asNonNegativeInteger(payload.droppedMessageCount);
    const forceReason = asString(payload.forceReason);
    if (payload.forceManaged === true || forceReason) {
      run.forcedContextPacks += 1;
      incrementCounter(run.forcedContextReasons, forceReason || "unspecified");
    }
  }

  if (event.event === "agent.execute_recovery_context_compacted") {
    run.contextPacks += 1;
    run.forcedContextPacks += 1;
    run.actualDroppedMessages += asNonNegativeInteger(payload.droppedMessageCount);
    incrementCounter(
      run.forcedContextReasons,
      asString(payload.forceReason) || "execute_recovery",
    );
  }

  if (event.event === "agent.loop_stop") {
    incrementCounter(run.stopReasons, asString(payload.reason) || "unspecified");
  }
  if (isNoActionStop(event)) run.noActionStops += 1;
}

function buildAggregate(runs) {
  const aggregate = {
    runCount: runs.length,
    maxIteration: 0,
    totalObservedIterations: 0,
    totalToolCalls: 0,
    unclassifiedToolCalls: 0,
    readFileCalls: 0,
    mutationToolCalls: 0,
    validationToolCalls: 0,
    firstMutationIteration: null,
    runsWithMutation: 0,
    noActionStops: 0,
    providerCompatibilityRetries: 0,
    contextPacks: 0,
    forcedContextPacks: 0,
    actualDroppedMessages: 0,
    providerRequests: 0,
    providerProtocolFailures: 0,
    providerTransportFailures: 0,
    providerRequestTimeouts: 0,
    toolDeadlineExceeded: 0,
    subagentRequests: 0,
    subagentsJoined: 0,
    recoveryExhaustions: 0,
    softSignals: 0,
    validationPasses: 0,
    validationFailures: 0,
    invalidValidationAttempts: 0,
    validationFallbacks: 0,
    failureReadWindows: 0,
    sourceMismatchRefreshes: 0,
    runtimeOwnedSourceRefreshes: 0,
    normalizedToolBatches: 0,
    discardedToolCalls: 0,
    mutationPreflightRejections: 0,
    oversizedMutationRejections: 0,
    outsideWorkspaceMutationRejections: 0,
    correctiveTargetRejections: 0,
    investigationMutationSurfaceViolations: 0,
    sourceGapMutationSurfaceViolations: 0,
    mutationRequestsWithoutLease: 0,
    mutationEditorFallbacks: 0,
    maxAvailableContextEntries: 0,
    maxDroppedContextEntries: 0,
    contextAnchorLosses: 0,
    workflowModes: {},
    runtimeIntents: {},
    runtimeVersions: {},
    toolCallsByName: {},
    stopReasons: {},
    forcedContextReasons: {},
    executePolicies: {},
    mutationLeaseAuthorities: {},
    phaseTransitions: {},
    projections: {},
  };

  for (const run of runs) {
    aggregate.maxIteration = Math.max(aggregate.maxIteration, run.maxIteration);
    aggregate.totalObservedIterations += run.maxIteration;
    for (const field of [
      "totalToolCalls",
      "unclassifiedToolCalls",
      "readFileCalls",
      "mutationToolCalls",
      "validationToolCalls",
      "noActionStops",
      "providerCompatibilityRetries",
      "contextPacks",
      "forcedContextPacks",
      "actualDroppedMessages",
      "providerRequests",
      "providerProtocolFailures",
      "providerTransportFailures",
      "providerRequestTimeouts",
      "toolDeadlineExceeded",
      "subagentRequests",
      "subagentsJoined",
      "recoveryExhaustions",
      "softSignals",
      "validationPasses",
      "validationFailures",
      "invalidValidationAttempts",
      "validationFallbacks",
      "failureReadWindows",
      "sourceMismatchRefreshes",
      "runtimeOwnedSourceRefreshes",
      "normalizedToolBatches",
      "discardedToolCalls",
      "mutationPreflightRejections",
      "oversizedMutationRejections",
      "outsideWorkspaceMutationRejections",
      "correctiveTargetRejections",
      "investigationMutationSurfaceViolations",
      "sourceGapMutationSurfaceViolations",
      "mutationRequestsWithoutLease",
      "mutationEditorFallbacks",
      "contextAnchorLosses",
    ]) {
      aggregate[field] += run[field];
    }
    aggregate.maxAvailableContextEntries = Math.max(
      aggregate.maxAvailableContextEntries,
      run.maxAvailableContextEntries,
    );
    aggregate.maxDroppedContextEntries = Math.max(
      aggregate.maxDroppedContextEntries,
      run.maxDroppedContextEntries,
    );
    if (run.firstMutationIteration !== null) {
      aggregate.runsWithMutation += 1;
      aggregate.firstMutationIteration = aggregate.firstMutationIteration === null
        ? run.firstMutationIteration
        : Math.min(aggregate.firstMutationIteration, run.firstMutationIteration);
    }
    incrementCounter(aggregate.workflowModes, run.workflowMode || "unknown");
    incrementCounter(aggregate.runtimeIntents, run.runtimeIntent || "unknown");
    incrementCounter(aggregate.runtimeVersions, run.runtimeVersion || "unknown");
    for (const field of [
      "toolCallsByName",
      "stopReasons",
      "forcedContextReasons",
      "executePolicies",
      "mutationLeaseAuthorities",
      "phaseTransitions",
      "projections",
    ]) {
      for (const [key, count] of Object.entries(run[field])) {
        incrementCounter(aggregate[field], key, count);
      }
    }
  }

  return aggregate;
}

export function analyzeAgentRuntimeEvents(events) {
  const runs = [];
  let currentRun = null;
  const runtimeV2Runs = new Map();

  for (const event of events) {
    if (!event || typeof event !== "object") continue;
    if (event.event === "agent.loop_start") {
      currentRun = createRun(event, runs.length + 1);
      runs.push(currentRun);
    }
    const runtimeV2RunId = event.event.startsWith("store.runtime_v2_")
      ? asString(event.payload?.runId)
      : null;
    if (
      event.event === "store.runtime_v2_execute_admitted" &&
      runtimeV2RunId &&
      !runtimeV2Runs.has(runtimeV2RunId)
    ) {
      const run = createRun(event, runs.length + 1);
      runtimeV2Runs.set(runtimeV2RunId, run);
      runs.push(run);
    }
    if (
      runtimeV2RunId &&
      event.event.startsWith("store.runtime_v2_") &&
      !runtimeV2Runs.has(runtimeV2RunId)
    ) {
      const run = createRun(event, runs.length + 1);
      runtimeV2Runs.set(runtimeV2RunId, run);
      runs.push(run);
    }
    const targetRun = runtimeV2RunId
      ? runtimeV2Runs.get(runtimeV2RunId)
      : currentRun;
    if (targetRun && isRuntimeMetricEvent(event)) {
      applyEventToRun(targetRun, event);
    }
  }

  return {
    schemaVersion: 2,
    runs,
    aggregate: buildAggregate(runs),
  };
}

export function analyzeAgentRuntimeLog(logText) {
  return analyzeAgentRuntimeEvents(parseAgentRuntimeLog(logText));
}

function resolveLogPath(inputPath) {
  if (!inputPath) {
    return path.join(os.homedir(), "Library/Logs/com.localagent.ide/main-debug.log");
  }
  if (inputPath === "~") return os.homedir();
  if (inputPath.startsWith("~/")) return path.join(os.homedir(), inputPath.slice(2));
  return path.resolve(inputPath);
}

async function main() {
  const sourcePath = resolveLogPath(process.argv[2]);
  const logText = await fs.readFile(sourcePath, "utf8");
  const report = analyzeAgentRuntimeLog(logText);
  process.stdout.write(`${JSON.stringify({ sourcePath, ...report }, null, 2)}\n`);
}

const isDirectRun = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectRun) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
