import { executeTool } from "../../lib/toolExecutor";
import {
  type RuntimeV2RunIdentity,
  type RuntimeV2WorkPlanReference,
  type SealedWorkPlanV1,
} from "../../lib/runtime-v2";
import type { ConversationTurn } from "../../lib/workflowModels";
import { PlanLedger } from "./planLedger";
import {
  toRuntimeV2WorkPlanReference,
  type RuntimeV2PlanReviewCommit,
} from "./workPlanAdapter";
import type { RuntimeV2SubmissionContext } from "./submissionContext";

interface PlanReviewProjectionHost {
  readonly set: (patchOrUpdater: any) => void;
}

export async function writeReviewArtifact(input: {
  readonly context: RuntimeV2SubmissionContext;
  readonly ledger: PlanLedger;
  readonly run: RuntimeV2RunIdentity;
  readonly plan: SealedWorkPlanV1;
}): Promise<void> {
  const command = await input.ledger.schedule(input.run, "execute_tool", {
    toolName: "write_file",
    target: ".MAIN/plans/plan.md",
    runtimeOwnedPlanArtifact: true,
  });
  try {
    await executeTool(
      "write_file",
      { path: ".MAIN/plans/plan.md", content: input.plan.markdown },
      input.context.runWorkspace || "",
      input.context.runSessionKey,
    );
    await input.ledger.settleCommand({
      type: "tool.completed",
      run: input.run,
      idempotencyKey: command.idempotencyKey,
      status: "succeeded",
      evidence: [{
        id: `plan-artifact:${input.plan.id}:${input.plan.revision}`,
        kind: "tool",
        target: ".MAIN/plans/plan.md",
        version: input.plan.projectionHash,
      }],
    });
  } catch (error) {
    await input.ledger.settleCommand({
      type: "tool.completed",
      run: input.run,
      idempotencyKey: command.idempotencyKey,
      status: "failed",
      evidence: [],
    });
    throw error;
  }
}

function reviewRequest(commit: RuntimeV2PlanReviewCommit) {
  return {
    schemaVersion: 1 as const,
    requestId: commit.review.requestId,
    kind: "plan_review" as const,
    sessionKey: commit.review.sessionKey,
    sessionEpoch: commit.review.sessionEpoch,
    turnId: commit.review.turnId,
    runId: commit.review.runId,
    parentRunId: commit.review.parentRunId,
    title: "计划已准备好，请确认是否执行",
    status: "pending" as const,
    createdAt: commit.review.createdAt,
    planRevision: commit.authority.revision,
    artifactHash: commit.authority.projectionHash,
    artifactPaths: [commit.artifact.path],
  };
}

export function applyReviewProjection(
  input: PlanReviewProjectionHost,
  commit: RuntimeV2PlanReviewCommit,
): void {
  input.set((state: any) => ({
    activeActionRequest: reviewRequest(commit),
    showPlanPanel: true,
    rightPanelTab: "plan",
    planStage: "ready_to_execute",
    isPlanApproved: false,
    conversationTurns: state.conversationTurns.map((turn: ConversationTurn) =>
      turn.id === commit.review.turnId
        ? {
            ...turn,
            status: "awaiting_approval" as const,
            summary: commit.panel.title,
          }
        : turn
    ),
  }));
}

export async function publishReviewMilestone(input: {
  readonly ledger: PlanLedger;
  readonly commit: RuntimeV2PlanReviewCommit;
}): Promise<void> {
  const projection = {
    id: input.ledger.nextId("runtime-v2-plan-review"),
    audience: "chat_milestone" as const,
    markdown: input.commit.chat.markdown,
    kind: "milestone" as const,
    dedupeKey: input.commit.chat.dedupeKey,
  };
  await input.ledger.publish(projection);
}

export function planReference(plan: SealedWorkPlanV1): RuntimeV2WorkPlanReference {
  return toRuntimeV2WorkPlanReference(plan, "pending_review");
}
