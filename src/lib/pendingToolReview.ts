import type { TaskBlock } from "./taskTypes";
import {
  ACTION_REQUEST_SCHEMA_VERSION,
  createActionRequestId,
  type ToolPermissionActionRequest,
} from "./actionRequest";

type PendingToolCallLike = {
  toolCallId?: string;
  name?: string;
  arguments?: unknown;
  risk?: "local_file_read" | "browser_control";
  localFileReadPath?: string;
  shellPermissionDecision?: unknown;
} | null | undefined;

type ToolTaskBlock = Extract<TaskBlock, { type: "tool" }>;

function normalizeToolArguments(value: unknown): Record<string, unknown> {
  if (!value) return {};
  if (typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value !== "string") return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

export function summarizePendingPatchTarget(patch: string): string {
  const targets: string[] = [];
  const addTarget = (value: string) => {
    const clean = String(value || "")
      .replace(/^["']|["']$/g, "")
      .replace(/^[ab]\//, "")
      .trim();
    if (!clean || clean === "/dev/null" || targets.includes(clean)) return;
    targets.push(clean);
  };

  for (const line of String(patch || "").split(/\r?\n/)) {
    const update = line.match(/^\*\*\* Update File:\s+(.+)$/);
    const add = line.match(/^\*\*\* Add File:\s+(.+)$/);
    const del = line.match(/^\*\*\* Delete File:\s+(.+)$/);
    const unified = line.match(/^\+\+\+\s+(.+)$/);
    if (update) addTarget(update[1]);
    else if (add) addTarget(add[1]);
    else if (del) addTarget(del[1]);
    else if (unified) addTarget(unified[1]);
    if (targets.length >= 3) break;
  }

  if (targets.length === 0) return "";
  return `${targets[0]}${targets.length > 1 ? ` +${targets.length - 1}` : ""}`;
}

export function derivePendingReviewTarget(toolName: string, args: Record<string, unknown>, localFileReadPath?: string): string {
  if (localFileReadPath && localFileReadPath.trim()) return localFileReadPath.trim();
  if (toolName === "apply_patch") {
    return summarizePendingPatchTarget(String(args.patch || "")) || "workspace patch";
  }
  for (const key of ["path", "command", "url", "query", "pattern", "target", "file", "cwd", "input"]) {
    const value = args[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return toolName || "tool request";
}

export function buildToolPermissionActionRequest(input: {
  sessionKey: string;
  turnId: string;
  runId: string;
  parentRunId?: string | null;
  title: string;
  taskId: number;
  toolCall: NonNullable<PendingToolCallLike>;
  now?: number;
}): ToolPermissionActionRequest {
  const now = input.now ?? Date.now();
  const toolName = String(input.toolCall.name || "tool").trim() || "tool";
  const args = normalizeToolArguments(input.toolCall.arguments);
  const risk: ToolPermissionActionRequest["risk"] = input.toolCall.shellPermissionDecision
    ? "shell"
    : input.toolCall.risk || (/^(?:apply_patch|replace_in_file|write_file|delete_file)$/i.test(toolName) ? "write" : "unknown");
  return {
    schemaVersion: ACTION_REQUEST_SCHEMA_VERSION,
    requestId: createActionRequestId("tool_permission", input.runId, now),
    kind: "tool_permission",
    sessionKey: input.sessionKey,
    turnId: input.turnId,
    runId: input.runId,
    parentRunId: input.parentRunId || null,
    title: String(input.title || "").trim() || toolName,
    status: "pending",
    createdAt: now,
    taskId: input.taskId,
    toolName,
    target: derivePendingReviewTarget(toolName, args, input.toolCall.localFileReadPath),
    risk,
  };
}

export function buildPendingReviewFallbackTask(input: {
  taskId: number | null;
  toolCall: PendingToolCallLike;
  turnId?: string | null;
}): ToolTaskBlock | null {
  if (input.taskId == null || !input.toolCall) return null;
  const toolName = String(input.toolCall.name || "tool");
  const args = normalizeToolArguments(input.toolCall.arguments);
  return {
    id: input.taskId,
    turnId: input.turnId || undefined,
    type: "tool",
    toolName,
    target: derivePendingReviewTarget(toolName, args, input.toolCall.localFileReadPath),
    status: "pending_review",
    toolStatus: "pending",
    message: "Waiting for approval.",
    ...(input.toolCall.shellPermissionDecision ? { shellPermissionDecision: input.toolCall.shellPermissionDecision as any } : {}),
  };
}

export function resolveVisiblePendingToolReview(input: {
  taskFlow: TaskBlock[];
  request: ToolPermissionActionRequest | null | undefined;
  pendingReviewTaskId: number | null;
  pendingToolCall: PendingToolCallLike;
  activeDiffTask?: unknown;
}): ToolTaskBlock | null {
  const request = input.request;
  if (
    !request ||
    request.status !== "pending" ||
    input.pendingReviewTaskId !== request.taskId
  ) {
    return null;
  }

  const isExactRequestTask = (task: ToolTaskBlock | null | undefined): task is ToolTaskBlock =>
    !!task && task.type === "tool" && task.id === request.taskId && task.turnId === request.turnId;
  const activeTask = input.activeDiffTask as ToolTaskBlock | null | undefined;
  if (isExactRequestTask(activeTask)) {
    return {
      ...activeTask,
      status: "pending_review",
      toolStatus: activeTask.toolStatus === "pending" ? activeTask.toolStatus : "pending",
    };
  }

  const pendingTask = input.taskFlow.find((task): task is ToolTaskBlock =>
    task.type === "tool" && task.id === request.taskId && task.turnId === request.turnId
  );
  if (pendingTask) {
    return {
      ...pendingTask,
      status: "pending_review",
      toolStatus: pendingTask.toolStatus === "pending" ? pendingTask.toolStatus : "pending",
    };
  }

  const pendingToolCall = input.pendingToolCall;
  if (!pendingToolCall) return null;
  const pendingToolName = String(pendingToolCall.name || "tool").trim() || "tool";
  const pendingToolArgs = normalizeToolArguments(pendingToolCall.arguments);
  const pendingTarget = derivePendingReviewTarget(
    pendingToolName,
    pendingToolArgs,
    pendingToolCall.localFileReadPath,
  );
  if (pendingToolName !== request.toolName || pendingTarget !== request.target) return null;

  return buildPendingReviewFallbackTask({
    taskId: request.taskId,
    toolCall: pendingToolCall,
    turnId: request.turnId,
  });
}
