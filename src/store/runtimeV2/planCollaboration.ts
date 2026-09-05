import {
  decideNextCommands,
  executeRuntimeV2SchedulerLifecycle,
  runtimeV2CollaborationPayload,
  runtimeV2SubagentStartHasRunway,
  type RuntimeV2Command,
  type RuntimeV2DecisionInput,
  type RuntimeV2NormalizedProviderResult,
  type RuntimeV2RunIdentity,
  type WorkPlanRuntimeEvidence,
} from "../../lib/runtime-v2";
import { resolveSubagentCapacityPolicy } from "../../lib/subagents";
import { createRuntimeV2SchedulerPort } from "./executionSchedulerPort";
import { upsertRuntimeV2ContextAnchor } from "./executionProviderHistory";
import {
  createRuntimeV2LiveExecutionState,
  type RuntimeV2LiveExecutionState,
} from "./executionTypes";
import { PlanLedger } from "./planLedger";
import type { RuntimeV2PlanLog } from "./planEvidencePort";
import type { RuntimeV2PlanRunnerInput } from "./planRunnerTypes";

type PlanToolCall =
  RuntimeV2NormalizedProviderResult["toolCalls"][number];

export interface RuntimeV2PlanCollaboration {
  readonly live: RuntimeV2LiveExecutionState;
  activeChildCount(): number;
  current(): {
    readonly decision: RuntimeV2DecisionInput;
    readonly payload: Readonly<Record<string, unknown>>;
  };
  executeProviderCall(
    call: PlanToolCall,
    decision: RuntimeV2DecisionInput,
  ): Promise<boolean>;
  joinActive(reason: string): Promise<boolean>;
  abortAndDrain(reason: string): Promise<boolean>;
  syncChildEvidence(): void;
  abortChildren(reason: string): void;
}

function activeChildJobs(
  ledger: PlanLedger,
  run: RuntimeV2RunIdentity,
) {
  return (ledger.snapshot()?.subagents || []).filter((job) =>
    job.parentRunId === run.runId &&
    (job.status === "queued" || job.status === "running")
  );
}

export function createRuntimeV2PlanCollaboration(input: {
  readonly runner: RuntimeV2PlanRunnerInput;
  readonly ledger: PlanLedger;
  readonly run: RuntimeV2RunIdentity;
  readonly messages: RuntimeV2LiveExecutionState["messages"];
  readonly evidence: WorkPlanRuntimeEvidence[];
  readonly evidenceContents: Map<string, string>;
  readonly deadlineAt: number;
  readonly logStoreEvent: RuntimeV2PlanLog;
}): RuntimeV2PlanCollaboration {
  const collaborationDeadlineAt = input.deadlineAt;
  const live: RuntimeV2LiveExecutionState = {
    ...createRuntimeV2LiveExecutionState(),
    messages: input.messages,
  };
  const ports = {
    get: input.runner.get,
    set: input.runner.set,
    context: input.runner.context,
    live,
    nextId: (scope: string) => input.ledger.nextId(scope),
    now: Date.now,
    lifecycleDeadlineAt: collaborationDeadlineAt,
    logStoreEvent: input.logStoreEvent,
  };
  const scheduler = createRuntimeV2SchedulerPort(ports);

  const syncChildEvidence = () => {
    const aggregate = input.ledger.snapshot();
    if (!aggregate) return;
    for (const event of aggregate.events) {
      if (
        event.type !== "subagent.completed" ||
        event.status !== "completed" ||
        !event.report
      ) continue;
      const job = aggregate.subagents.find((entry) => entry.id === event.jobId);
      const evidenceIds = [...new Set(
        event.evidence.map((evidence) => evidence.id),
      )];
      const findingContext = event.report.findings.map((finding) =>
        `Finding: ${finding.statement} (evidence: ${finding.evidenceIds.join(", ")})`
      ).join("\n").slice(0, 4_000);
      upsertRuntimeV2ContextAnchor(live, {
        key: `child:${event.jobId}`,
        content: [
          `Scope: ${job?.scopeKey || "recovered planning child"} (${job?.allowedPaths.join(", ") || "bounded read scope"})`,
          "Status: completed",
          `Evidence ids: ${evidenceIds.join(", ") || "none"}`,
          `Report: ${event.report.summary.slice(0, 4_000)}`,
          findingContext,
          "When relying on a child fact, explicitly cite its exact evidence id in the next structured action or final answer.",
        ].filter(Boolean).join("\n"),
      });
      const citedStatements = new Map<string, string[]>();
      for (const finding of event.report.findings) {
        for (const evidenceId of finding.evidenceIds) {
          const statements = citedStatements.get(evidenceId) || [];
          statements.push(finding.statement);
          citedStatements.set(evidenceId, statements);
        }
      }
      for (const evidence of event.evidence) {
        const statements = citedStatements.get(evidence.id);
        if (!statements?.length) continue;
        if (!input.evidence.some((entry) => entry.id === evidence.id)) {
          input.evidence.push({
            id: evidence.id,
            target: evidence.target,
            // A child observation is bounded advisory evidence. Only the
            // parent Plan reader may establish source-version authority for
            // modify/delete targets.
            version: null,
            statement: [...new Set(statements)].join(" ").slice(0, 4_000),
          });
        }
        if (!input.evidenceContents.has(evidence.id)) {
          input.evidenceContents.set(evidence.id, [
            `Child report: ${event.report.summary}`,
            ...[...new Set(statements)].map((statement) =>
              `Finding: ${statement}`
            ),
          ].join("\n").slice(0, 10_000));
        }
      }
    }
  };

  const executeSchedulerCommand = async (
    command: RuntimeV2Command,
  ): Promise<boolean> => {
    await input.ledger.scheduleCommand(command);
    try {
      const events = await executeRuntimeV2SchedulerLifecycle({
        command,
        scheduler,
        signal: input.runner.context.abortCtrl.signal,
        getScheduledSubagents: () =>
          input.ledger.snapshot()?.subagents || [],
        commitPrepared: async (event) => {
          await input.ledger.appendProgress(event);
        },
      });
      for (const event of events) {
        if (event.type === "command.completed") {
          await input.ledger.settleCommand(event);
        } else {
          await input.ledger.appendProgress(event);
        }
      }
      syncChildEvidence();
      return true;
    } catch (error) {
      if (input.ledger.snapshot()?.scheduledCommands.some((scheduled) =>
        scheduled.idempotencyKey === command.idempotencyKey
      )) {
        await input.ledger.settleCommand({
          type: "command.completed",
          run: command.run,
          idempotencyKey: command.idempotencyKey,
          status: input.runner.context.abortCtrl.signal.aborted
            ? "canceled"
            : "failed",
        });
      }
      await input.ledger.recordSoftSignal(input.run, "repeated_action");
      input.logStoreEvent("runtime_v2_plan_collaboration_failed", {
        turnId: input.run.turnId,
        runId: input.run.runId,
        commandKind: command.kind,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  };

  const collaboration: RuntimeV2PlanCollaboration = {
    live,
    activeChildCount: () => activeChildJobs(input.ledger, input.run).length,
    current() {
      const aggregate = input.ledger.snapshot()!;
      const preference =
        input.runner.context.turnInputContextSignals?.subagentPreference ||
        "unspecified";
      const requirement =
        aggregate.subagentRequirement ??
        input.runner.context.turnInputContextSignals?.subagentRequirement ??
        "optional";
      const effectivePreference = requirement === "required"
        ? "allowed"
        : preference;
      const collaborationAllowed =
        requirement === "required" ||
        preference === "allowed" || preference === "preferred";
      const subagentPolicy = collaborationAllowed
        ? resolveSubagentCapacityPolicy(input.runner.get().config)
        : {
            maxActiveRequests: 0,
            modelRequestMode: "serialized" as const,
          };
      const decision = {
        subagentPreference: effectivePreference,
        subagentCapacity: subagentPolicy.maxActiveRequests,
        subagentRequestMode: subagentPolicy.modelRequestMode,
      } as const;
      const requirementMet = aggregate.subagents.some((job) =>
        job.parentRunId === input.run.runId
      );
      const payload = runtimeV2CollaborationPayload(aggregate, decision);
      const spawnHasRunway = runtimeV2SubagentStartHasRunway({
        now: ports.now(),
        lifecycleDeadlineAt: collaborationDeadlineAt,
      });
      return {
        decision,
        payload: {
          ...payload,
          remainingSubagentCapacity: spawnHasRunway
            ? payload.remainingSubagentCapacity
            : 0,
          collaborationAllowed,
          collaborationRequired: requirement === "required",
          collaborationRequirementMet: requirementMet,
        },
      };
    },
    async executeProviderCall(call, decision) {
      const aggregate = input.ledger.snapshot();
      if (!aggregate) return false;
      const command = decideNextCommands(aggregate, decision)[0];
      if (
        !command ||
        (
          command.kind !== "schedule_subagents" &&
          command.kind !== "join_subagents"
        ) ||
        command.payload.toolCallId !== call.id
      ) {
        throw new Error(
          `RUNTIME_V2_PLAN_COLLABORATION_COMMAND_MISMATCH:${call.name}`,
        );
      }
      return executeSchedulerCommand(command);
    },
    async joinActive(reason) {
      const jobs = activeChildJobs(input.ledger, input.run);
      if (jobs.length === 0) return true;
      const command = await input.ledger.schedule(
        input.run,
        "join_subagents",
        {
          mode: "read_only",
          jobIds: jobs.map((job) => job.id),
          finalJoin: true,
          automaticJoinReason: String(reason || "plan_join_boundary")
            .slice(0, 256),
        },
      );
      // schedule() already crossed the durable boundary; execute the shared
      // lifecycle without scheduling the same command a second time.
      try {
        const events = await executeRuntimeV2SchedulerLifecycle({
          command,
          scheduler,
          signal: input.runner.context.abortCtrl.signal,
          getScheduledSubagents: () =>
            input.ledger.snapshot()?.subagents || [],
          commitPrepared: async (event) => {
            await input.ledger.appendProgress(event);
          },
        });
        for (const event of events) {
          if (event.type === "command.completed") {
            await input.ledger.settleCommand(event);
          } else {
            await input.ledger.appendProgress(event);
          }
        }
        syncChildEvidence();
        return true;
      } catch (error) {
        if (input.ledger.snapshot()?.scheduledCommands.some((scheduled) =>
          scheduled.idempotencyKey === command.idempotencyKey
        )) {
          await input.ledger.settleCommand({
            type: "command.completed",
            run: command.run,
            idempotencyKey: command.idempotencyKey,
            status: input.runner.context.abortCtrl.signal.aborted
              ? "canceled"
              : "failed",
          });
        }
        input.logStoreEvent("runtime_v2_plan_collaboration_join_failed", {
          turnId: input.run.turnId,
          runId: input.run.runId,
          jobIds: jobs.map((job) => job.id),
          error: error instanceof Error ? error.message : String(error),
        });
        return false;
      }
    },
    async abortAndDrain(reason) {
      if (activeChildJobs(input.ledger, input.run).length === 0) return true;
      for (const controller of live.childAbortControllers.values()) {
        controller.abort(`runtime_v2_${reason}`);
      }
      const joined = await collaboration.joinActive(reason);
      return joined && activeChildJobs(input.ledger, input.run).length === 0;
    },
    syncChildEvidence,
    abortChildren(reason) {
      for (const controller of live.childAbortControllers.values()) {
        controller.abort(reason);
      }
    },
  };
  // Rehydrate completed child findings before the first recovered provider
  // request. The canonical ledger, not process-local transcript state, owns
  // this evidence across a cold restart.
  syncChildEvidence();
  return collaboration;
}
