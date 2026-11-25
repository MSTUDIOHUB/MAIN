import {
  runtimeV2SubagentModelHandle,
  type RuntimeV2Command,
  type RuntimeV2SubagentJob,
  type SchedulerPort,
} from "../../lib/runtime-v2";
import { upsertRuntimeV2ContextAnchor } from "./executionProviderAnchors";
import { closeCollaborationToolCall } from "./executionSchedulerAdmission";
import { commitRuntimeV2StagedChildBatch } from "./executionSubagentMutation";
import type {
  RuntimeV2ChildResult,
  RuntimeV2ExecutionPortsInput,
} from "./executionTypes";

export const SUBAGENT_WAIT_NO_ACTIVE_RESPONSE =
  "SUBAGENT_WAIT_NO_ACTIVE: All spawned subagents have already completed and been joined above. No active subagents remain; do not call wait_subagents again. Continue directly or conclude.";

/** Close an explicit wait_subagents call when no active children remain. */
export function closeNoActiveSubagentWaitCall(
  input: RuntimeV2ExecutionPortsInput,
  command: RuntimeV2Command,
): void {
  closeCollaborationToolCall(input, command, SUBAGENT_WAIT_NO_ACTIVE_RESPONSE);
}

/** Record one joined child's context anchor and report whether it landed in live messages. */
export function recordRuntimeV2JoinedChildAnchor(
  live: RuntimeV2ExecutionPortsInput["live"],
  result: RuntimeV2ChildResult,
): {
  readonly contextEntryId: string;
  readonly evidenceIds: readonly string[];
  readonly delivered: boolean;
} {
  const contextEntryId = `child:${result.job.id}`;
  const evidenceIds = [...new Set(result.evidence.map((evidence) => evidence.id))];
  const reviewFindingLines = result.job.taskKind === "review" && result.status === "completed" && result.report?.findings.length
    ? result.report.findings.map((finding, index) => {
        const findingId = finding.id?.trim() || `${result.job.id}:f${index + 1}`;
        const severity = finding.severity || (/\[BLOCKING\]/i.test(finding.statement) ? "blocking" : "advisory");
        return `- finding_id=${findingId} [${severity.toUpperCase()}]: ${finding.statement}`;
      })
    : [];
  const content = [
    `Scope: ${result.job.scopeKey} (${result.job.allowedPaths.join(", ")})`,
    `Status: ${result.status}`,
    `Evidence ids: ${evidenceIds.join(", ") || "none"}`,
    `Report: ${result.summary}`,
    ...(reviewFindingLines.length > 0 ? ["Findings:", ...reviewFindingLines] : []),
    evidenceIds.length > 0
      ? "When relying on a child fact, explicitly cite its exact evidence id in the next structured action or final answer."
      : "No child evidence id is available for parent adoption; continue the objective directly.",
    reviewFindingLines.some((line) => line.includes("[BLOCKING]"))
      ? "Action required: verify each [BLOCKING] finding against current source/validation, repair within authorized scope if confirmed, and settle every blocking finding with resolve_review_finding."
      : "",
  ].filter(Boolean).join("\n");
  upsertRuntimeV2ContextAnchor(live, { key: contextEntryId, content });
  const delivered = live.messages.some((message) =>
    message.role === "system" &&
    typeof message.content === "string" &&
    message.content.startsWith(`[runtime-v2 context: ${contextEntryId}]`) &&
    message.content.includes(`Report: ${result.summary}`) &&
    message.content.includes(`Evidence ids: ${evidenceIds.join(", ") || "none"}`)
  );
  return { contextEntryId, evidenceIds, delivered };
}

/** Write the batch-level settled summary anchor when all children in the Run have settled. */
export function writeRuntimeV2SettledBatchAnchor(
  live: RuntimeV2ExecutionPortsInput["live"],
  allObservedJobs: readonly RuntimeV2SubagentJob[],
  batchCount: number,
): void {
  const settledJobs = allObservedJobs.filter((job) =>
    job.status !== "queued" && job.status !== "running"
  );
  const completedCount = settledJobs.filter((job) => job.status === "completed").length;
  const degradedCount = settledJobs.filter((job) => job.status === "degraded").length;
  const otherSettledCount = settledJobs.length - completedCount - degradedCount;
  const settledHandles = settledJobs.map((job) => {
    const handle = runtimeV2SubagentModelHandle(job);
    const scopeSuffix = job.scopeKey && job.scopeKey !== handle ? ` / scope=${job.scopeKey}` : "";
    const pathSuffix = job.allowedPaths.length > 0 ? ` [${job.allowedPaths.join(", ")}]` : "";
    return `${handle}${scopeSuffix}${pathSuffix}: ${job.status}`;
  });
  upsertRuntimeV2ContextAnchor(live, {
    key: "subagent-batch-settled",
    content: [
      `Total settled subagents: ${settledJobs.length} (completed: ${completedCount}, degraded: ${degradedCount}${
        otherSettledCount > 0 ? `, failed/canceled: ${otherSettledCount}` : ""
      }).`,
      `Joined in this batch: ${batchCount}.`,
      `Handles/scopes: ${settledHandles.join("; ")}.`,
      "No active subagents remain; do NOT call wait_subagents again. Continue directly from the delivered child results or conclude.",
    ].join("\n"),
  });
}

/** Format joined child summaries for the parent's wait_subagents tool result. */
export function formatRuntimeV2SubagentJoinResults(
  results: readonly (RuntimeV2ChildResult | null)[],
  observedJobs: readonly RuntimeV2SubagentJob[],
): string {
  return [
    "SUBAGENT_RESULTS",
    ...results.flatMap((result) =>
      result
        ? [
            `Handle: ${runtimeV2SubagentModelHandle(result.job)}`,
            `Status: ${result.status}`,
            `Evidence ids: ${result.evidence.map((evidence) => evidence.id).join(", ") || "none"}`,
            `Summary: ${result.summary}`,
          ]
        : []
    ),
    observedJobs.some((job) => job.status !== "completed")
      ? "One or more child tasks did not complete. Continue the objective directly using any retained evidence."
      : "Apply child findings only when they are relevant to the parent objective.",
    "When relying on a child fact, explicitly cite its exact evidence id. An uncited child result remains delivered but not adopted.",
  ].join("\n");
}

/** Revalidate and atomically join a child's single staged write transaction. */
export async function commitCompletedRuntimeV2ChildTransaction(input: {
  readonly ports: RuntimeV2ExecutionPortsInput;
  readonly command: Parameters<SchedulerPort["execute"]>[0]["command"];
  readonly result: RuntimeV2ChildResult;
  readonly signal: AbortSignal;
}): Promise<RuntimeV2ChildResult> {
  const staged = input.result.stagedMutations || [];
  if (
    input.result.status !== "completed" ||
    input.result.job.taskKind !== "implement" ||
    input.result.job.accessMode !== "write"
  ) {
    return input.result;
  }
  if (staged.length === 0) {
    return {
      ...input.result,
      status: input.result.evidence.length > 0 ? "degraded" : "failed",
      summary:
        "实现子任务没有形成可提交的修改暂存；未改变工作区，父线程继续接管。",
      report: null,
      evidence: input.result.evidence,
      stagedMutations: [],
    };
  }
  const commit = await commitRuntimeV2StagedChildBatch({
    ports: input.ports,
    parentCommand: input.command,
    job: input.result.job,
    stagedList: staged,
    signal: input.signal,
  });
  if (!commit.committed) {
    const stagedIds = new Set(staged.map((item) => item.evidenceId));
    const retained = input.result.evidence.filter((evidence) =>
      !stagedIds.has(evidence.id)
    );
    input.ports.logStoreEvent("runtime_v2_subagent_mutation_discarded", {
      turnId: input.command.run.turnId,
      runId: input.command.run.runId,
      jobId: input.result.job.id,
      reason: commit.message,
      targets: [...new Set(staged.flatMap((item) => item.targets))],
    });
    return {
      ...input.result,
      status: retained.length > 0 ? "degraded" : "failed",
      summary: `实现子任务的暂存修改未提交：${commit.message} 工作区未因该事务改变，父线程继续接管。`,
      report: null,
      evidence: retained,
      stagedMutations: [],
    };
  }
  const stagedIds = new Set(staged.map((item) => item.evidenceId));
  return {
    ...input.result,
    evidence: [
      ...input.result.evidence.filter((evidence) =>
        !stagedIds.has(evidence.id)
      ),
      ...commit.evidence,
    ],
    stagedMutations: [],
  };
}
