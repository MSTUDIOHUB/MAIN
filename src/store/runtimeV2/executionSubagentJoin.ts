import type { SchedulerPort } from "../../lib/runtime-v2";
import type { RuntimeV2ExecutionPortsInput } from "./executionContext";
import { commitRuntimeV2StagedChildMutation } from "./executionSubagentMutation";
import type { RuntimeV2ChildResult } from "./executionTypes";

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
  if (staged.length !== 1) {
    const retained = input.result.evidence.filter((evidence) =>
      !staged.some((item) => item.evidenceId === evidence.id)
    );
    return {
      ...input.result,
      status: retained.length > 0 ? "degraded" : "failed",
      summary:
        "实现子任务没有形成唯一、可提交的修改事务；未改变工作区，父线程继续接管。",
      report: null,
      evidence: retained,
      stagedMutations: [],
    };
  }
  const commit = await commitRuntimeV2StagedChildMutation({
    ports: input.ports,
    parentCommand: input.command,
    job: input.result.job,
    staged: staged[0]!,
    signal: input.signal,
  });
  if (!commit.committed) {
    const retained = input.result.evidence.filter((evidence) =>
      evidence.id !== staged[0]!.evidenceId
    );
    input.ports.logStoreEvent("runtime_v2_subagent_mutation_discarded", {
      turnId: input.command.run.turnId,
      runId: input.command.run.runId,
      jobId: input.result.job.id,
      reason: commit.message,
      targets: staged[0]!.targets,
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
