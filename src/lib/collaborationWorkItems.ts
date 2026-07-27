import { normalizeWorkspacePathIdentity } from "./workspacePaths";

export const COLLABORATION_WORK_ITEM_SCHEMA_VERSION =
  "collaboration-work-item.v1" as const;
export const COLLABORATION_LEDGER_SCHEMA_VERSION =
  "collaboration-ledger.v1" as const;

export type CollaborationTaskKind =
  | "explore"
  | "review"
  | "implement"
  | "validate";

export type CollaborationAccessMode = "read" | "write";

export type CollaborationTaskLifecycleState =
  | "created"
  | "queued"
  | "running"
  | "summarizing"
  | "completed"
  | "partial"
  | "blocked"
  | "canceled"
  | "interrupted"
  | "closed";

export type CollaborationTaskTerminalState =
  | "completed"
  | "partial"
  | "blocked"
  | "canceled"
  | "interrupted";

export interface CollaborationWorkItemV1 {
  schemaVersion: typeof COLLABORATION_WORK_ITEM_SCHEMA_VERSION;
  /** Runtime identity. The model never chooses or reuses this value. */
  collaborationTaskId: string;
  /** Model-authored stable label within the current parent Turn. */
  taskKey: string;
  taskKind: CollaborationTaskKind;
  objective: string;
  delegationReason: string;
  successCriteria: string[];
  expectedOutput: string;
  requiredPaths: string[];
  allowedPaths: string[];
  accessMode: CollaborationAccessMode;
  dependsOn: string[];
  independentReviewOf?: string;
  /** Optional Goal-mode parent relation. Ordinary Turns leave it absent. */
  goalSliceId?: string;
  semanticFingerprint: string;
}

export interface CollaborationLedgerEntryV1 {
  workItem: CollaborationWorkItemV1;
  parentTurnId: string;
  subagentId: string;
  runId: string;
  state: CollaborationTaskLifecycleState;
  /** Preserves the outcome after the lifecycle advances to `closed`. */
  terminalState?: CollaborationTaskTerminalState;
  evidenceReceiptIds: string[];
  createdAt: number;
  updatedAt: number;
  closedAt?: number;
}

export interface CollaborationLedgerV1 {
  schemaVersion: typeof COLLABORATION_LEDGER_SCHEMA_VERSION;
  parentTurnId: string;
  entries: CollaborationLedgerEntryV1[];
  updatedAt: number;
}

export interface CollaborationWorkItemDraft {
  taskKey?: unknown;
  taskKind?: unknown;
  objective?: unknown;
  delegationReason?: unknown;
  successCriteria?: unknown;
  expectedOutput?: unknown;
  requiredPaths?: unknown;
  allowedPaths?: unknown;
  accessMode?: unknown;
  dependsOn?: unknown;
  independentReviewOf?: unknown;
  goalSliceId?: unknown;
}

export type CollaborationWorkItemValidation =
  | { ok: true; workItem: CollaborationWorkItemV1 }
  | { ok: false; reason: string; missingFields: string[] };

const TASK_KINDS = new Set<CollaborationTaskKind>([
  "explore",
  "review",
  "implement",
  "validate",
]);
const ACCESS_MODES = new Set<CollaborationAccessMode>(["read", "write"]);
const LIFECYCLE_STATES = new Set<CollaborationTaskLifecycleState>([
  "created",
  "queued",
  "running",
  "summarizing",
  "completed",
  "partial",
  "blocked",
  "canceled",
  "interrupted",
  "closed",
]);
const TERMINAL_STATES = new Set<CollaborationTaskTerminalState>([
  "completed",
  "partial",
  "blocked",
  "canceled",
  "interrupted",
]);

function compactString(value: unknown, maxChars: number): string {
  const normalized = String(value ?? "").replace(/\s+/g, " ").trim();
  return normalized.length > maxChars
    ? normalized.slice(0, maxChars).trimEnd()
    : normalized;
}

function normalizeStringList(
  value: unknown,
  options: { maxItems: number; maxChars: number; paths?: boolean },
): string[] {
  const raw = Array.isArray(value)
    ? value
    : String(value ?? "").split(/[\n,;]+/);
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of raw) {
    const display = compactString(item, options.maxChars).replace(/\\/g, "/");
    if (!display) continue;
    const identity = options.paths
      ? normalizeWorkspacePathIdentity(display)
      : display.toLocaleLowerCase();
    if (!identity || seen.has(identity)) continue;
    seen.add(identity);
    result.push(display);
    if (result.length >= options.maxItems) break;
  }
  return result;
}

function canonicalSemanticText(value: unknown): string {
  return String(value ?? "")
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[`"'*_#()[\]{}]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function hashFingerprint(value: string): string {
  // FNV-1a is deterministic across providers and JavaScript runtimes. This is
  // an identity key, not a security boundary.
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `collab-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

export function buildCollaborationSemanticFingerprint(input: {
  taskKind: CollaborationTaskKind;
  objective: string;
  successCriteria: string[];
  expectedOutput: string;
}): string {
  return hashFingerprint([
    input.taskKind,
    canonicalSemanticText(input.objective),
    [...input.successCriteria]
      .map(canonicalSemanticText)
      .filter(Boolean)
      .sort()
      .join("\u001e"),
    canonicalSemanticText(input.expectedOutput),
  ].join("\u001f"));
}

export function normalizeCollaborationWorkItemDraft(input: {
  collaborationTaskId: string;
  draft: CollaborationWorkItemDraft;
}): CollaborationWorkItemValidation {
  const collaborationTaskId = compactString(input.collaborationTaskId, 128);
  const taskKey = compactString(input.draft.taskKey, 96);
  const taskKindValue = compactString(input.draft.taskKind, 24) as CollaborationTaskKind;
  const objective = compactString(input.draft.objective, 800);
  const delegationReason = compactString(input.draft.delegationReason, 500);
  const successCriteria = normalizeStringList(input.draft.successCriteria, {
    maxItems: 12,
    maxChars: 500,
  });
  const expectedOutput = compactString(input.draft.expectedOutput, 500);
  const requiredPaths = normalizeStringList(input.draft.requiredPaths, {
    maxItems: 12,
    maxChars: 500,
    paths: true,
  });
  const allowedPaths = normalizeStringList(input.draft.allowedPaths, {
    maxItems: 12,
    maxChars: 500,
    paths: true,
  });
  const accessModeValue = compactString(
    input.draft.accessMode,
    12,
  ) as CollaborationAccessMode;
  const dependsOn = normalizeStringList(input.draft.dependsOn, {
    maxItems: 12,
    maxChars: 128,
  });
  const independentReviewOf = compactString(input.draft.independentReviewOf, 128);
  const goalSliceId = compactString(input.draft.goalSliceId, 128);

  const missingFields: string[] = [];
  if (!collaborationTaskId) missingFields.push("collaboration_task_id");
  if (!taskKey) missingFields.push("task_key");
  if (!TASK_KINDS.has(taskKindValue)) missingFields.push("task_kind");
  if (!objective) missingFields.push("objective");
  if (!delegationReason) missingFields.push("delegation_reason");
  if (successCriteria.length === 0) missingFields.push("success_criteria");
  if (!expectedOutput) missingFields.push("expected_output");
  if (!Object.prototype.hasOwnProperty.call(input.draft, "requiredPaths")) {
    missingFields.push("required_paths");
  }
  if (allowedPaths.length === 0) missingFields.push("allowed_paths");
  if (!ACCESS_MODES.has(accessModeValue)) missingFields.push("access_mode");
  if (taskKindValue === "implement" && accessModeValue !== "write") {
    missingFields.push("implement_requires_write_access");
  }
  if (taskKindValue !== "implement" && accessModeValue === "write") {
    missingFields.push("write_access_requires_implement_task");
  }
  if (requiredPaths.some((requiredPath) =>
    !allowedPaths.some((allowedPath) => {
      const allowed = normalizeWorkspacePathIdentity(allowedPath);
      const required = normalizeWorkspacePathIdentity(requiredPath);
      return allowed === "." || required === allowed || required.startsWith(`${allowed}/`);
    })
  )) {
    missingFields.push("required_paths_outside_allowed_paths");
  }
  if (missingFields.length > 0) {
    return {
      ok: false,
      reason: `COLLABORATION_WORK_ITEM_INVALID:${missingFields.join(",")}`,
      missingFields,
    };
  }

  const semanticFingerprint = buildCollaborationSemanticFingerprint({
    taskKind: taskKindValue,
    objective,
    successCriteria,
    expectedOutput,
  });
  return {
    ok: true,
    workItem: {
      schemaVersion: COLLABORATION_WORK_ITEM_SCHEMA_VERSION,
      collaborationTaskId,
      taskKey,
      taskKind: taskKindValue,
      objective,
      delegationReason,
      successCriteria,
      expectedOutput,
      requiredPaths,
      allowedPaths,
      accessMode: accessModeValue,
      dependsOn,
      ...(independentReviewOf ? { independentReviewOf } : {}),
      ...(goalSliceId ? { goalSliceId } : {}),
      semanticFingerprint,
    },
  };
}

export function normalizeCollaborationWorkItem(
  value: unknown,
): CollaborationWorkItemV1 | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== COLLABORATION_WORK_ITEM_SCHEMA_VERSION) return null;
  const normalized = normalizeCollaborationWorkItemDraft({
    collaborationTaskId: compactString(record.collaborationTaskId, 128),
    draft: {
      taskKey: record.taskKey,
      taskKind: record.taskKind,
      objective: record.objective,
      delegationReason: record.delegationReason,
      successCriteria: record.successCriteria,
      expectedOutput: record.expectedOutput,
      requiredPaths: record.requiredPaths,
      allowedPaths: record.allowedPaths,
      accessMode: record.accessMode,
      dependsOn: record.dependsOn,
      independentReviewOf: record.independentReviewOf,
      goalSliceId: record.goalSliceId,
    },
  });
  if (!normalized.ok || !normalized.workItem.collaborationTaskId) return null;
  if (record.semanticFingerprint !== normalized.workItem.semanticFingerprint) return null;
  return normalized.workItem;
}

export function normalizeCollaborationLedger(
  value: unknown,
  options?: { parentTurnId?: string; coldRestore?: boolean; now?: number },
): CollaborationLedgerV1 | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== COLLABORATION_LEDGER_SCHEMA_VERSION) return null;
  const parentTurnId = compactString(record.parentTurnId, 128);
  if (!parentTurnId || (options?.parentTurnId && parentTurnId !== options.parentTurnId)) {
    return null;
  }
  const entriesValue = Array.isArray(record.entries) ? record.entries : null;
  if (!entriesValue || entriesValue.length > 64) return null;
  const now = Math.max(0, Number(options?.now ?? Date.now()));
  const entries: CollaborationLedgerEntryV1[] = [];
  const seenTasks = new Set<string>();
  const seenAgents = new Set<string>();
  const seenRuns = new Set<string>();
  for (const candidate of entriesValue) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return null;
    const entry = candidate as Record<string, unknown>;
    const workItem = normalizeCollaborationWorkItem(entry.workItem);
    const subagentId = compactString(entry.subagentId, 128);
    const runId = compactString(entry.runId, 128);
    const entryParentTurnId = compactString(entry.parentTurnId, 128);
    const state = compactString(entry.state, 32) as CollaborationTaskLifecycleState;
    const terminalStateValue = compactString(
      entry.terminalState,
      32,
    ) as CollaborationTaskTerminalState;
    const createdAt = Number(entry.createdAt);
    const updatedAt = Number(entry.updatedAt);
    if (
      !workItem ||
      !subagentId ||
      !runId ||
      entryParentTurnId !== parentTurnId ||
      !LIFECYCLE_STATES.has(state) ||
      (
        terminalStateValue.length > 0 &&
        !TERMINAL_STATES.has(terminalStateValue)
      ) ||
      !Number.isFinite(createdAt) ||
      !Number.isFinite(updatedAt) ||
      seenTasks.has(workItem.collaborationTaskId) ||
      seenAgents.has(subagentId) ||
      seenRuns.has(runId)
    ) return null;
    seenTasks.add(workItem.collaborationTaskId);
    seenAgents.add(subagentId);
    seenRuns.add(runId);
    const closedByColdRestore = options?.coldRestore === true &&
      state !== "closed";
    const inferredTerminalState = terminalStateValue ||
      (
          state !== "closed" &&
          TERMINAL_STATES.has(state as CollaborationTaskTerminalState)
        ? state as CollaborationTaskTerminalState
        : undefined
      );
    const restoredState = closedByColdRestore ? "closed" : state;
    const restoredTerminalState = closedByColdRestore
      ? inferredTerminalState || "interrupted"
      : inferredTerminalState || (state === "closed" ? "interrupted" : undefined);
    entries.push({
      workItem,
      parentTurnId,
      subagentId,
      runId,
      state: restoredState,
      ...(restoredTerminalState
        ? { terminalState: restoredTerminalState }
        : {}),
      evidenceReceiptIds: normalizeStringList(entry.evidenceReceiptIds, {
        maxItems: 48,
        maxChars: 160,
      }),
      createdAt,
      updatedAt: closedByColdRestore
        ? Math.max(updatedAt, now)
        : updatedAt,
      ...(closedByColdRestore || Number.isFinite(Number(entry.closedAt))
        ? { closedAt: closedByColdRestore ? now : Number(entry.closedAt) }
        : {}),
    });
  }
  const updatedAt = Math.max(
    Number.isFinite(Number(record.updatedAt)) ? Number(record.updatedAt) : 0,
    ...entries.map((entry) => entry.updatedAt),
  );
  return {
    schemaVersion: COLLABORATION_LEDGER_SCHEMA_VERSION,
    parentTurnId,
    entries,
    updatedAt,
  };
}

export function createEmptyCollaborationLedger(
  parentTurnId: string,
  now = Date.now(),
): CollaborationLedgerV1 {
  return {
    schemaVersion: COLLABORATION_LEDGER_SCHEMA_VERSION,
    parentTurnId,
    entries: [],
    updatedAt: now,
  };
}
