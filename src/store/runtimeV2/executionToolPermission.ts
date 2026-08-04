import {
  isPlanExecutionRunProvenanceForOwner,
  capturePlanExecutionRunProvenance,
} from "../../lib/planExecutionProvenance";
import { buildToolPermissionActionRequest } from "../../lib/pendingToolReview";
import { reduceRunTransition } from "../../lib/runTransitionReducer";
import type { ToolReviewDecision } from "../../lib/toolReviewDecision";
import {
  normalizeLocalFileReadPath,
  type ToolRiskLevel,
} from "../../lib/toolCapabilities";
import { withEventSchema } from "../../lib/turnEvents";
import type { TaskBlock } from "../../lib/taskTypes";
import type { RuntimeV2Command } from "../../lib/runtime-v2";
import type { RuntimeV2ExecutionPortsInput } from "./executionTypes";

function ownsRuntimeV2PermissionRun(
  state: any,
  command: RuntimeV2Command,
): boolean {
  const marker = state?.harnessRunMarker;
  return !!marker &&
    marker.sessionKey === command.run.sessionKey &&
    marker.turnId === command.run.turnId &&
    marker.runId === command.run.runId &&
    (marker.status === "running" || marker.status === "paused");
}

function exactTimelineToolBlock(
  taskFlow: readonly TaskBlock[],
  command: RuntimeV2Command,
  target: string,
): Extract<TaskBlock, { type: "tool" }> | null {
  for (let index = taskFlow.length - 1; index >= 0; index -= 1) {
    const block = taskFlow[index]!;
    if (
      block.type === "tool" &&
      block.turnId === command.run.turnId &&
      block.runId === command.run.runId &&
      String(block.toolCallId || "") === command.idempotencyKey &&
      normalizeLocalFileReadPath(block.target) === target
    ) {
      return block;
    }
  }
  return null;
}

function pendingMessage(language: "zh" | "en"): string {
  return language === "en"
    ? "Waiting for approval before execution."
    : "等待用户批准后执行。";
}

/**
 * Project one exact Runtime v2 effect into the existing ActionRequest UI and
 * await its existing resolver. This adapter creates no second approval state
 * machine: the store's allow/reject actions remain the sole decision owner.
 */
export async function requestRuntimeV2ToolPermission(input: {
  readonly ports: RuntimeV2ExecutionPortsInput;
  readonly command: RuntimeV2Command;
  readonly toolName: string;
  readonly args: Record<string, unknown>;
  readonly target: string;
  readonly risk: ToolRiskLevel;
  readonly permissionTarget: string;
  readonly signal?: AbortSignal;
}): Promise<ToolReviewDecision> {
  const set = input.ports.set;
  const normalizedTarget = normalizeLocalFileReadPath(
    input.permissionTarget,
  );
  if (!set || !normalizedTarget) {
    return {
      action: "error",
      error: "RUNTIME_V2_PERMISSION_ADAPTER_UNAVAILABLE",
    };
  }

  const initial = input.ports.get();
  if (!ownsRuntimeV2PermissionRun(initial, input.command)) {
    return {
      action: "error",
      error: "RUNTIME_V2_PERMISSION_OWNER_MISMATCH",
    };
  }
  const existingBlock = exactTimelineToolBlock(
    initial.taskFlow || [],
    input.command,
    normalizedTarget,
  );
  const taskId = existingBlock?.id ?? initial._nextTaskId();
  const turn = (initial.conversationTurns || []).find(
    (candidate: any) => candidate.id === input.command.run.turnId,
  );
  const capturedPlanExecution = capturePlanExecutionRunProvenance(
    initial.planLifecycle,
  );
  const planExecution =
    capturedPlanExecution &&
      isPlanExecutionRunProvenanceForOwner(capturedPlanExecution, {
        sessionKey: input.command.run.sessionKey,
        turnId: input.command.run.turnId,
        runId: input.command.run.runId,
        parentRunId: input.command.run.parentRunId,
      })
      ? capturedPlanExecution
      : undefined;
  const permissionToolCall = {
    toolCallId: input.command.idempotencyKey,
    name: input.toolName,
    arguments: { ...input.args, path: normalizedTarget },
    risk: input.risk,
    localFileReadPath: normalizedTarget,
  };
  const request = buildToolPermissionActionRequest({
    sessionKey: input.command.run.sessionKey,
    turnId: input.command.run.turnId,
    runId: input.command.run.runId,
    parentRunId: input.command.run.parentRunId,
    title: String(turn?.title || turn?.userPrompt || input.toolName),
    taskId,
    toolCall: permissionToolCall,
    ...(planExecution ? { planExecution } : {}),
    now: input.ports.now(),
  });

  let installed = false;
  let settled = false;
  let resolver: (decision: ToolReviewDecision) => void = () => undefined;
  const decision = new Promise<ToolReviewDecision>((resolve) => {
    resolver = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
  });

  set((state: any) => {
    if (
      !ownsRuntimeV2PermissionRun(state, input.command) ||
      (
        state.activeActionRequest &&
        state.activeActionRequest.status === "pending"
      )
    ) {
      return {};
    }
    const currentBlock = exactTimelineToolBlock(
      state.taskFlow || [],
      input.command,
      normalizedTarget,
    );
    if (existingBlock && currentBlock?.id !== taskId) return {};

    const pendingBlock: Extract<TaskBlock, { type: "tool" }> = {
      ...(currentBlock || {
        id: taskId,
        turnId: input.command.run.turnId,
        type: "tool" as const,
        toolName: input.toolName,
        target: normalizedTarget,
        status: "running",
        toolStatus: "running",
        runId: input.command.run.runId,
        parentRunId: input.command.run.parentRunId,
        toolCallId: input.command.idempotencyKey,
        dedupeKey:
          `runtime-v2-permission:${input.command.idempotencyKey}`,
      }),
      target: normalizedTarget,
      status: "pending_review",
      toolStatus: "pending",
      message: pendingMessage(input.ports.context.phaseLanguage),
    };
    const taskFlow = currentBlock
      ? (state.taskFlow || []).map((block: TaskBlock) =>
          block.id === taskId ? pendingBlock : block
        )
      : [...(state.taskFlow || []), pendingBlock];
    const transitioned = reduceRunTransition({
      activeActionRequest: state.activeActionRequest || null,
      runtimeEvents: state.runtimeEvents || [],
    }, {
      type: "action_required",
      request,
      events: [withEventSchema({
        type: "approval.requested",
        threadId: request.sessionKey,
        turnId: request.turnId,
        timestampMs: input.ports.now(),
        requestId: request.requestId,
        actionKind: request.kind,
        title: request.title,
        reason: "tool_permission",
        target: normalizedTarget,
        runId: request.runId,
        parentRunId: request.parentRunId || null,
      })],
    });
    installed = true;
    return {
      activeActionRequest: transitioned.activeActionRequest,
      runtimeEvents: transitioned.runtimeEvents,
      pendingReviewTaskId: taskId,
      pendingReviewResolve: resolver,
      pendingToolCall: permissionToolCall,
      agentStatus: "pending_review",
      isGenerating: false,
      taskFlow,
      conversationTurns: (state.conversationTurns || []).map(
        (candidate: any) =>
          (
            candidate.id === input.command.run.turnId ||
            candidate.id === input.ports.context.uiDisplayTurnId
          )
            ? {
                ...candidate,
                status: "awaiting_approval",
                blockIds: candidate.blockIds.includes(taskId)
                  ? candidate.blockIds
                  : [...candidate.blockIds, taskId],
              }
            : candidate,
      ),
    };
  });

  if (!installed) {
    return {
      action: "error",
      error: "RUNTIME_V2_PERMISSION_REQUEST_CONFLICT",
    };
  }

  input.ports.logStoreEvent("runtime_v2_tool_permission_requested", {
    turnId: request.turnId,
    runId: request.runId,
    requestId: request.requestId,
    commandIdempotencyKey: input.command.idempotencyKey,
    toolName: input.toolName,
    target: normalizedTarget,
    risk: input.risk,
  });

  const abort = () => {
    set((state: any) =>
      state.activeActionRequest?.requestId === request.requestId &&
        state.pendingReviewResolve === resolver
        ? {
            activeActionRequest: null,
            pendingReviewTaskId: null,
            pendingReviewResolve: null,
            pendingToolCall: null,
          }
        : {}
    );
    resolver({
      action: "error",
      error: "RUNTIME_V2_PERMISSION_REQUEST_CANCELED",
    });
  };
  if (input.signal?.aborted) abort();
  else input.signal?.addEventListener("abort", abort, { once: true });

  const resolved = await decision;
  input.signal?.removeEventListener("abort", abort);
  if (resolved.action === "accept") {
    const grantedPath = normalizeLocalFileReadPath(
      resolved.grantLocalFileReadPath,
    );
    if (grantedPath !== normalizedTarget) {
      return {
        action: "error",
        error: "RUNTIME_V2_PERMISSION_GRANT_TARGET_MISMATCH",
      };
    }
  }
  input.ports.logStoreEvent("runtime_v2_tool_permission_resolved", {
    turnId: request.turnId,
    runId: request.runId,
    requestId: request.requestId,
    commandIdempotencyKey: input.command.idempotencyKey,
    toolName: input.toolName,
    target: normalizedTarget,
    decision: resolved.action,
  });
  return resolved;
}
