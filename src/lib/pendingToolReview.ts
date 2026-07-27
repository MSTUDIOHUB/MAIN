import type { TaskBlock } from "./taskTypes";
import {
  ACTION_REQUEST_SCHEMA_VERSION,
  createActionRequestId,
  type ToolPermissionPlanExecutionIdentity,
  type ToolPermissionActionRequest,
} from "./actionRequest";

type PendingToolCallLike = {
  toolCallId?: string;
  name?: string;
  arguments?: unknown;
  risk?: ToolPermissionActionRequest["risk"];
  localFileReadPath?: string;
  shellPermissionDecision?: unknown;
} | null | undefined;

type ToolTaskBlock = Extract<TaskBlock, { type: "tool" }>;

export interface PendingToolReviewOwnerIdentity {
  taskId?: number | null;
  turnIds: readonly (string | null | undefined)[];
  toolCallId?: string | null;
  toolName: string;
  target: string;
}

/**
 * One ownership rule for every pending-review projection. An explicit runtime
 * call id never falls back to semantic matching; legacy records without that
 * id must match both the final tool name and the exact disclosed target.
 */
export function isExactPendingToolReviewOwner(
  task: TaskBlock | null | undefined,
  owner: PendingToolReviewOwnerIdentity,
): task is ToolTaskBlock {
  if (!task || task.type !== "tool") return false;
  if (owner.taskId != null && task.id !== owner.taskId) return false;
  const allowedTurnIds = owner.turnIds
    .map((turnId) => String(turnId || "").trim())
    .filter(Boolean);
  if (allowedTurnIds.length > 0 && !allowedTurnIds.includes(String(task.turnId || "").trim())) {
    return false;
  }

  const expectedToolCallId = String(owner.toolCallId || "").trim();
  if (expectedToolCallId) {
    const taskToolCallId = String(
      task.toolCallId || (task as ToolTaskBlock & { executionId?: string }).executionId || "",
    ).trim();
    return taskToolCallId === expectedToolCallId;
  }

  return String(task.toolName || "").trim() === String(owner.toolName || "").trim() &&
    String(task.target || "").trim() === String(owner.target || "").trim();
}

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

export interface PendingReviewArgumentDisclosure {
  argumentName: string;
  detail: string;
  summaryTruncated: boolean;
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

export function summarizeDesktopControlTarget(args: Record<string, unknown>): string {
  const appName = String(args.app_name || args.appName || args.app || "desktop app").trim() || "desktop app";
  const actionLines = String(args.actions || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .slice(0, 3)
    .map((line) => line.replace(/^(fill\s*:[^=]{0,240})=>[\s\S]*$/i, "$1=> [text]"));
  const launchOnly = args.launch === true || args.launch === "true";
  const actionSummary = actionLines.length > 0
    ? actionLines.join("; ")
    : launchOnly
      ? "launch"
      : "inspect";
  const screenshot = args.screenshot === true || args.screenshot === "true"
    ? " · screenshot"
    : "";
  return `${appName} · ${actionSummary}${screenshot}`;
}

export function redactPendingReviewSecrets(value: string): string {
  return String(value || "")
    .replace(/(authorization\s*:\s*bearer\s+)[^\s;]+/gi, "$1[redacted]")
    .replace(/(authorization\s*:\s*basic\s+)[A-Za-z0-9+/=]+/gi, "$1[redacted]")
    .replace(/([a-z][a-z0-9+.-]*:\/\/)([^\s/:@]+):([^\s/@]+)@/gi, "$1[redacted]@")
    .replace(/((?:api[_-]?key|access[_-]?token|token|password|secret)\s*[=:]\s*)(?:"[^"]*"|'[^']*'|[^\s;]+)/gi, "$1[redacted]")
    .replace(/(--(?:api[_-]?key|access[_-]?token|token|password|secret)(?:=|\s+))(?:"[^"]*"|'[^']*'|[^\s;]+)/gi, "$1[redacted]");
}

export function summarizePendingReviewText(value: string, maxLength = 240): string {
  const redacted = redactPendingReviewSecrets(value)
    .replace(/\s+/g, " ")
    .trim();
  if (redacted.length <= maxLength) return redacted;
  return `${redacted.slice(0, Math.max(1, maxLength - 1)).trimEnd()}…`;
}

/**
 * Keep the durable ActionRequest target compact while separately exposing the
 * exact final command/SQL bytes that are about to execute. The detail is read
 * only from the exact in-memory pending tool call and secrets are redacted,
 * but no suffix is dropped: a dangerous trailing segment must remain visible.
 */
export function derivePendingReviewArgumentDisclosure(
  toolName: string,
  args: Record<string, unknown>,
): PendingReviewArgumentDisclosure | null {
  const preferredKeys = toolName === "run_command" || toolName === "execute_command"
    ? ["command", "cmd", "input"]
    : toolName === "send_pty_input"
    ? ["input", "command"]
    : ["sql", "statement", "query"];
  const argumentName = preferredKeys.find((key) =>
    typeof args[key] === "string" && String(args[key]).trim().length > 0
  );
  if (!argumentName) return null;
  const raw = String(args[argumentName]);
  const detail = redactPendingReviewSecrets(raw).trim();
  if (!detail) return null;
  return {
    argumentName,
    detail,
    summaryTruncated: detail.replace(/\s+/g, " ").trim().length > 240,
  };
}

export function getPendingToolReviewArgumentDisclosure(
  toolCall: PendingToolCallLike,
): PendingReviewArgumentDisclosure | null {
  if (!toolCall) return null;
  return derivePendingReviewArgumentDisclosure(
    String(toolCall.name || "tool").trim() || "tool",
    normalizeToolArguments(toolCall.arguments),
  );
}

export function derivePendingReviewTarget(toolName: string, args: Record<string, unknown>, localFileReadPath?: string): string {
  if (localFileReadPath && localFileReadPath.trim()) return summarizePendingReviewText(localFileReadPath);
  if (toolName === "apply_patch") {
    return summarizePendingPatchTarget(String(args.patch || "")) || "workspace patch";
  }
  if (toolName === "computer_use") return summarizeDesktopControlTarget(args);
  for (const key of ["path", "command", "url", "app_name", "appName", "sql", "query", "statement", "pattern", "target", "file", "cwd", "input"]) {
    const value = args[key];
    if (typeof value === "string" && value.trim()) return summarizePendingReviewText(value);
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
  planExecution?: ToolPermissionPlanExecutionIdentity;
  now?: number;
}): ToolPermissionActionRequest {
  const now = input.now ?? Date.now();
  const toolName = String(input.toolCall.name || "tool").trim() || "tool";
  const args = normalizeToolArguments(input.toolCall.arguments);
  const risk: ToolPermissionActionRequest["risk"] = input.toolCall.risk || (
    input.toolCall.shellPermissionDecision
      ? "shell"
      : /^(?:apply_patch|replace_in_file|write_file|delete_file)$/i.test(toolName)
      ? "write"
      : "unknown"
  );
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
    ...(input.toolCall.toolCallId ? { toolCallId: input.toolCall.toolCallId } : {}),
    toolName,
    target: derivePendingReviewTarget(toolName, args, input.toolCall.localFileReadPath),
    risk,
    ...(input.planExecution ? { planExecution: { ...input.planExecution } } : {}),
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
    ...(input.toolCall.toolCallId ? { toolCallId: input.toolCall.toolCallId } : {}),
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

  const requestOwner: PendingToolReviewOwnerIdentity = {
    taskId: request.taskId,
    turnIds: [request.turnId],
    toolCallId: request.toolCallId,
    toolName: request.toolName,
    target: request.target,
  };
  const isExactRequestTask = (task: ToolTaskBlock | null | undefined): task is ToolTaskBlock =>
    isExactPendingToolReviewOwner(task, requestOwner);
  const activeTask = input.activeDiffTask as ToolTaskBlock | null | undefined;
  if (isExactRequestTask(activeTask)) {
    return {
      ...activeTask,
      status: "pending_review",
      toolStatus: activeTask.toolStatus === "pending" ? activeTask.toolStatus : "pending",
    };
  }

  const pendingTask = input.taskFlow.find((task): task is ToolTaskBlock =>
    isExactRequestTask(task.type === "tool" ? task : null)
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
  if (request.toolCallId && pendingToolCall.toolCallId !== request.toolCallId) return null;
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
