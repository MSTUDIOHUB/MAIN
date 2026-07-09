import type { TaskBlock } from "./taskTypes";

type PendingToolCallLike = {
  name?: string;
  arguments?: unknown;
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
  pendingReviewTaskId: number | null;
  pendingToolCall: PendingToolCallLike;
  currentTurnId?: string | null;
  activeDiffTask?: unknown;
}): ToolTaskBlock | null {
  const activeTask = input.activeDiffTask as ToolTaskBlock | null | undefined;
  if (activeTask && activeTask.type === "tool") {
    return {
      ...activeTask,
      status: "pending_review",
      toolStatus: activeTask.toolStatus === "pending" ? activeTask.toolStatus : "pending",
    };
  }

  const byPendingId = input.pendingReviewTaskId != null
    ? input.taskFlow.find((task): task is ToolTaskBlock => task.type === "tool" && task.id === input.pendingReviewTaskId)
    : null;
  const byVisibleStatus = input.taskFlow.find((task): task is ToolTaskBlock =>
    task.type === "tool" &&
    (task.status === "pending_review" || (input.pendingReviewTaskId != null && task.id === input.pendingReviewTaskId && task.toolStatus === "pending"))
  );
  const pendingTask = byPendingId || byVisibleStatus;
  if (pendingTask) {
    return {
      ...pendingTask,
      status: "pending_review",
      toolStatus: pendingTask.toolStatus === "pending" ? pendingTask.toolStatus : "pending",
    };
  }

  return buildPendingReviewFallbackTask({
    taskId: input.pendingReviewTaskId,
    toolCall: input.pendingToolCall,
    turnId: input.currentTurnId,
  });
}
