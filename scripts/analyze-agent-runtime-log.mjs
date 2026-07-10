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
  return {
    runIndex,
    startedAt: event.timestamp,
    endedAt: event.timestamp,
    workflowMode: asString(payload.workflowMode),
    runtimeIntent: asString(payload.runtimeIntent),
    iterationLimit: asNonNegativeInteger(payload.maxIterations),
    maxIteration: 0,
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
    toolCallsByName: {},
    stopReasons: {},
    forcedContextReasons: {},
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
    event.event === "store.non_actionable_stop";
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
      incrementCounter(run.toolCallsByName, name);
      if (READ_FILE_TOOL_NAMES.has(name)) run.readFileCalls += 1;
      if (MUTATION_TOOL_NAMES.has(name)) {
        run.mutationToolCalls += 1;
        const iteration = asNonNegativeInteger(payload.iteration);
        if (run.firstMutationIteration === null && iteration > 0) {
          run.firstMutationIteration = iteration;
        }
      }
      if (VALIDATION_TOOL_NAMES.has(name)) run.validationToolCalls += 1;
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
    workflowModes: {},
    runtimeIntents: {},
    toolCallsByName: {},
    stopReasons: {},
    forcedContextReasons: {},
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
    ]) {
      aggregate[field] += run[field];
    }
    if (run.firstMutationIteration !== null) {
      aggregate.runsWithMutation += 1;
      aggregate.firstMutationIteration = aggregate.firstMutationIteration === null
        ? run.firstMutationIteration
        : Math.min(aggregate.firstMutationIteration, run.firstMutationIteration);
    }
    incrementCounter(aggregate.workflowModes, run.workflowMode || "unknown");
    incrementCounter(aggregate.runtimeIntents, run.runtimeIntent || "unknown");
    for (const field of ["toolCallsByName", "stopReasons", "forcedContextReasons"]) {
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

  for (const event of events) {
    if (!event || typeof event !== "object") continue;
    if (event.event === "agent.loop_start") {
      currentRun = createRun(event, runs.length + 1);
      runs.push(currentRun);
    }
    if (currentRun && isRuntimeMetricEvent(event)) {
      applyEventToRun(currentRun, event);
    }
  }

  return {
    schemaVersion: 1,
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
