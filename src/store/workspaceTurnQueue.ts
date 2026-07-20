import {
  WORKSPACE_INSTRUCTION_SCHEMA_VERSION,
  WORKSPACE_INSTRUCTION_SOURCES,
  WORKSPACE_TURN_QUEUE_SCHEMA_VERSION,
  type WorkspaceInstruction,
  type WorkspaceInstructionAttachment,
  type WorkspaceInstructionPayload,
  type WorkspaceInstructionReceipt,
  type WorkspaceInstructionLedgerEntry,
  type WorkspaceJsonObject,
  type WorkspaceJsonValue,
  type WorkspaceTurnQueueClaim,
  type WorkspaceTurnQueueEntry,
  type WorkspaceTurnQueueState,
  type WorkspaceTurnTerminalOwner,
} from "../lib/workspaceInstruction";

interface WorkspaceTurnQueueCommandBase {
  readonly expectedVersion: number;
  /** Explicit event time keeps transitions deterministic and replayable. */
  readonly at: number;
}

interface WorkspaceTurnQueueEntryIdentity {
  readonly clientSubmissionId: string;
  readonly receiptId: string;
  readonly sessionKey: string;
  readonly sessionEpoch: string;
}

interface WorkspaceTurnQueueClaimIdentity {
  readonly claimId: string;
  readonly sessionKey: string;
  readonly sessionEpoch: string;
}

export type WorkspaceTurnQueueCommand =
  | (WorkspaceTurnQueueCommandBase & {
      readonly type: "append";
      readonly instruction: WorkspaceInstruction;
      readonly receipt: WorkspaceInstructionReceipt;
    })
  | (WorkspaceTurnQueueCommandBase & WorkspaceTurnQueueEntryIdentity & {
      /** Persistence succeeded; the Turn may now be dispatched. */
      readonly type: "commit";
    })
  | (WorkspaceTurnQueueCommandBase & WorkspaceTurnQueueClaimIdentity & {
      /** Claim the FIFO head. No clientSubmissionId is accepted, so callers cannot skip it. */
      readonly type: "claim";
    })
  | (WorkspaceTurnQueueCommandBase & WorkspaceTurnQueueClaimIdentity & {
      /** A nonterminal dispatch attempt ended; put the exact head back in the queue. */
      readonly type: "release";
    })
  | (WorkspaceTurnQueueCommandBase & WorkspaceTurnQueueClaimIdentity & {
      /** The exact Turn/Run adapter accepted the instruction; dequeue it. */
      readonly type: "ack";
      readonly turnOwner: WorkspaceTurnTerminalOwner;
    })
  | (WorkspaceTurnQueueCommandBase & WorkspaceTurnQueueClaimIdentity & {
      /** Remove the exact claimed head only after its exact Turn became terminal. */
      readonly type: "remove";
      readonly terminalOwner: WorkspaceTurnTerminalOwner;
    })
  | (WorkspaceTurnQueueCommandBase & WorkspaceTurnQueueEntryIdentity & {
      /** Persistence failed; discard only the exact still-persisting entry. */
      readonly type: "rollback";
    });

export type WorkspaceTurnQueueTransitionDisposition =
  | "applied"
  | "idempotent"
  | "rejected";

export type WorkspaceTurnQueueTransitionRejection =
  | "version_conflict"
  | "invalid_command_time"
  | "invalid_instruction"
  | "invalid_receipt"
  | "instruction_receipt_mismatch"
  | "queue_owner_mismatch"
  | "client_submission_conflict"
  | "entry_not_found"
  | "entry_state_conflict"
  | "queue_empty"
  | "head_persisting"
  | "head_dispatching"
  | "claim_id_mismatch"
  | "terminal_owner_mismatch"
  | "unknown_command";

export interface WorkspaceTurnQueueTransitionResult {
  readonly state: WorkspaceTurnQueueState;
  readonly disposition: WorkspaceTurnQueueTransitionDisposition;
  readonly reason?: WorkspaceTurnQueueTransitionRejection;
  /** Entry observed or changed by the transition; removed entries are returned here too. */
  readonly entry?: WorkspaceTurnQueueEntry;
}

export interface CreateWorkspaceTurnQueueStateInput {
  readonly sessionKey: string;
  readonly sessionEpoch: string;
  readonly updatedAt?: number;
}

export interface ReconcileWorkspaceTurnQueueOnRestoreInput {
  readonly snapshot: unknown;
  readonly sessionKey: string;
  readonly sessionEpoch: string;
  readonly terminalOwners?: readonly WorkspaceTurnTerminalOwner[];
  readonly at?: number;
}

const INVALID_JSON = Symbol("invalid-workspace-json");
const INSTRUCTION_SOURCE_SET = new Set<string>(WORKSPACE_INSTRUCTION_SOURCES);

function isRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isRequiredIdentityPart(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value === value.trim();
}

function isValidEventTime(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function normalizeJsonValue(
  value: unknown,
  ancestors: Set<object>,
  depth = 0,
): WorkspaceJsonValue | typeof INVALID_JSON {
  if (depth > 32) return INVALID_JSON;
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : INVALID_JSON;
  }
  if (Array.isArray(value)) {
    if (ancestors.has(value)) return INVALID_JSON;
    ancestors.add(value);
    const normalized: WorkspaceJsonValue[] = [];
    for (const item of value) {
      const result = normalizeJsonValue(item, ancestors, depth + 1);
      if (result === INVALID_JSON) {
        ancestors.delete(value);
        return INVALID_JSON;
      }
      normalized.push(result);
    }
    ancestors.delete(value);
    return Object.freeze(normalized);
  }
  if (!isRecord(value) || ancestors.has(value)) return INVALID_JSON;
  ancestors.add(value);
  const normalized: Record<string, WorkspaceJsonValue> = {};
  for (const key of Object.keys(value).sort((left, right) =>
    left < right ? -1 : left > right ? 1 : 0
  )) {
    const result = normalizeJsonValue(value[key], ancestors, depth + 1);
    if (result === INVALID_JSON) {
      ancestors.delete(value);
      return INVALID_JSON;
    }
    normalized[key] = result;
  }
  ancestors.delete(value);
  return Object.freeze(normalized) as WorkspaceJsonObject;
}

function normalizeJsonObject(value: unknown): WorkspaceJsonObject | null {
  if (!isRecord(value)) return null;
  const normalized = normalizeJsonValue(value, new Set());
  return normalized === INVALID_JSON || Array.isArray(normalized) || normalized === null ||
    typeof normalized !== "object"
    ? null
    : normalized as WorkspaceJsonObject;
}

function normalizeOptionalStringArray(value: unknown): readonly string[] | null {
  if (value === undefined) return Object.freeze([]);
  if (!Array.isArray(value)) return null;
  const normalized: string[] = [];
  for (const raw of value) {
    if (!isRequiredIdentityPart(raw)) return null;
    normalized.push(raw);
  }
  return Object.freeze(normalized);
}

function normalizeAttachment(value: unknown): WorkspaceInstructionAttachment | null {
  if (!isRecord(value)) return null;
  if (
    !isRequiredIdentityPart(value.id) ||
    !isRequiredIdentityPart(value.path) ||
    !isRequiredIdentityPart(value.displayName) ||
    (value.kind !== "text" && value.kind !== "document" && value.kind !== "tabular") ||
    (value.sourcePath !== undefined && !isRequiredIdentityPart(value.sourcePath)) ||
    (value.workspace !== undefined && !isRequiredIdentityPart(value.workspace)) ||
    (value.readable !== undefined && typeof value.readable !== "boolean")
  ) return null;
  return Object.freeze({
    id: value.id,
    path: value.path,
    displayName: value.displayName,
    kind: value.kind,
    ...(value.sourcePath !== undefined ? { sourcePath: value.sourcePath } : {}),
    ...(value.workspace !== undefined ? { workspace: value.workspace } : {}),
    ...(value.readable !== undefined ? { readable: value.readable } : {}),
  });
}

function normalizeOptionalAttachments(
  value: unknown,
): readonly WorkspaceInstructionAttachment[] | null {
  if (value === undefined) return Object.freeze([]);
  if (!Array.isArray(value)) return null;
  const normalized: WorkspaceInstructionAttachment[] = [];
  for (const raw of value) {
    const attachment = normalizeAttachment(raw);
    if (!attachment) return null;
    normalized.push(attachment);
  }
  return Object.freeze(normalized);
}

function normalizeInstructionPayload(value: unknown): WorkspaceInstructionPayload | null {
  if (!isRecord(value) || typeof value.text !== "string") return null;
  const images = normalizeOptionalStringArray(value.images);
  const contextMentions = normalizeOptionalStringArray(value.contextMentions);
  const attachedFiles = normalizeOptionalAttachments(value.attachedFiles);
  if (!images || !contextMentions || !attachedFiles) return null;
  const dispatchHints = value.dispatchHints === undefined
    ? undefined
    : normalizeJsonObject(value.dispatchHints);
  if (value.dispatchHints !== undefined && !dispatchHints) return null;
  if (
    !value.text.trim() &&
    images.length === 0 &&
    contextMentions.length === 0 &&
    attachedFiles.length === 0
  ) return null;
  return Object.freeze({
    text: value.text,
    ...(images.length > 0 ? { images } : {}),
    ...(contextMentions.length > 0 ? { contextMentions } : {}),
    ...(attachedFiles.length > 0 ? { attachedFiles } : {}),
    ...(dispatchHints ? { dispatchHints } : {}),
  });
}

export function normalizeWorkspaceInstruction(value: unknown): WorkspaceInstruction | null {
  if (!isRecord(value)) return null;
  const payload = normalizeInstructionPayload(value.payload);
  if (
    value.schemaVersion !== WORKSPACE_INSTRUCTION_SCHEMA_VERSION ||
    value.kind !== "workspace_instruction" ||
    !isRequiredIdentityPart(value.clientSubmissionId) ||
    !isRequiredIdentityPart(value.sessionKey) ||
    !isRequiredIdentityPart(value.sessionEpoch) ||
    typeof value.source !== "string" ||
    !INSTRUCTION_SOURCE_SET.has(value.source) ||
    !isValidEventTime(value.submittedAt) ||
    !payload
  ) return null;
  return Object.freeze({
    schemaVersion: WORKSPACE_INSTRUCTION_SCHEMA_VERSION,
    kind: "workspace_instruction",
    clientSubmissionId: value.clientSubmissionId,
    sessionKey: value.sessionKey,
    sessionEpoch: value.sessionEpoch,
    source: value.source as WorkspaceInstruction["source"],
    submittedAt: value.submittedAt,
    payload,
  });
}

export function normalizeWorkspaceInstructionReceipt(
  value: unknown,
): WorkspaceInstructionReceipt | null {
  if (!isRecord(value) ||
    value.schemaVersion !== WORKSPACE_INSTRUCTION_SCHEMA_VERSION ||
    value.kind !== "workspace_turn_receipt" ||
    !isRequiredIdentityPart(value.receiptId) ||
    !isRequiredIdentityPart(value.clientSubmissionId) ||
    !isRequiredIdentityPart(value.sessionKey) ||
    !isRequiredIdentityPart(value.sessionEpoch) ||
    !isRequiredIdentityPart(value.turnId) ||
    !Number.isSafeInteger(value.userBlockId) ||
    Number(value.userBlockId) <= 0 ||
    !isValidEventTime(value.acceptedAt)
  ) return null;
  return Object.freeze({
    schemaVersion: WORKSPACE_INSTRUCTION_SCHEMA_VERSION,
    kind: "workspace_turn_receipt",
    receiptId: value.receiptId,
    clientSubmissionId: value.clientSubmissionId,
    sessionKey: value.sessionKey,
    sessionEpoch: value.sessionEpoch,
    turnId: value.turnId,
    userBlockId: Number(value.userBlockId),
    acceptedAt: value.acceptedAt,
  });
}

export function normalizeWorkspaceInstructionLedger(
  value: unknown,
  sessionKey: string,
  sessionEpoch: string,
): readonly WorkspaceInstructionLedgerEntry[] {
  if (!Array.isArray(value)) return Object.freeze([]);
  const normalized: WorkspaceInstructionLedgerEntry[] = [];
  const seen = new Set<string>();
  for (const raw of value) {
    if (!isRecord(raw) ||
      !isRequiredIdentityPart(raw.clientSubmissionId) ||
      typeof raw.payloadIdentity !== "string" ||
      !raw.payloadIdentity
    ) continue;
    const receipt = normalizeWorkspaceInstructionReceipt(raw.receipt);
    if (!receipt ||
      receipt.clientSubmissionId !== raw.clientSubmissionId ||
      receipt.sessionKey !== sessionKey ||
      receipt.sessionEpoch !== sessionEpoch ||
      seen.has(receipt.clientSubmissionId)
    ) continue;
    seen.add(receipt.clientSubmissionId);
    normalized.push(Object.freeze({
      clientSubmissionId: receipt.clientSubmissionId,
      payloadIdentity: raw.payloadIdentity,
      receipt,
    }));
  }
  return Object.freeze(normalized);
}

function instructionMatchesReceipt(
  instruction: WorkspaceInstruction,
  receipt: WorkspaceInstructionReceipt,
): boolean {
  return instruction.clientSubmissionId === receipt.clientSubmissionId &&
    instruction.sessionKey === receipt.sessionKey &&
    instruction.sessionEpoch === receipt.sessionEpoch &&
    receipt.acceptedAt >= instruction.submittedAt;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(value);
}

function instructionsEqual(left: WorkspaceInstruction, right: WorkspaceInstruction): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function receiptsEqual(
  left: WorkspaceInstructionReceipt,
  right: WorkspaceInstructionReceipt,
): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function freezeEntry(entry: WorkspaceTurnQueueEntry): WorkspaceTurnQueueEntry {
  return Object.freeze(entry);
}

function freezeState(state: WorkspaceTurnQueueState): WorkspaceTurnQueueState {
  return Object.freeze({ ...state, entries: Object.freeze([...state.entries]) });
}

export function createWorkspaceTurnQueueState(
  input: CreateWorkspaceTurnQueueStateInput,
): WorkspaceTurnQueueState {
  if (!isRequiredIdentityPart(input.sessionKey) || !isRequiredIdentityPart(input.sessionEpoch)) {
    throw new Error("Workspace Turn queue requires an exact Session key and owner epoch.");
  }
  const updatedAt = input.updatedAt ?? 0;
  if (!isValidEventTime(updatedAt)) {
    throw new Error("Workspace Turn queue requires a finite non-negative update time.");
  }
  return freezeState({
    schemaVersion: WORKSPACE_TURN_QUEUE_SCHEMA_VERSION,
    version: 0,
    sessionKey: input.sessionKey,
    sessionEpoch: input.sessionEpoch,
    entries: Object.freeze([]),
    updatedAt,
  });
}

function rejected(
  state: WorkspaceTurnQueueState,
  reason: WorkspaceTurnQueueTransitionRejection,
  entry?: WorkspaceTurnQueueEntry,
): WorkspaceTurnQueueTransitionResult {
  return Object.freeze({ state, disposition: "rejected", reason, ...(entry ? { entry } : {}) });
}

function idempotent(
  state: WorkspaceTurnQueueState,
  entry?: WorkspaceTurnQueueEntry,
): WorkspaceTurnQueueTransitionResult {
  return Object.freeze({ state, disposition: "idempotent", ...(entry ? { entry } : {}) });
}

function applied(
  state: WorkspaceTurnQueueState,
  at: number,
  entries: readonly WorkspaceTurnQueueEntry[],
  entry?: WorkspaceTurnQueueEntry,
): WorkspaceTurnQueueTransitionResult {
  const nextState = freezeState({
    ...state,
    schemaVersion: WORKSPACE_TURN_QUEUE_SCHEMA_VERSION,
    version: state.version + 1,
    entries,
    updatedAt: Math.max(state.updatedAt, at),
  });
  return Object.freeze({
    state: nextState,
    disposition: "applied",
    ...(entry ? { entry } : {}),
  });
}

function commandOwnerMatches(
  state: WorkspaceTurnQueueState,
  owner: { readonly sessionKey: string; readonly sessionEpoch: string },
): boolean {
  return owner.sessionKey === state.sessionKey && owner.sessionEpoch === state.sessionEpoch;
}

function entryIdentityMatches(
  entry: WorkspaceTurnQueueEntry,
  identity: WorkspaceTurnQueueEntryIdentity,
): boolean {
  return entry.instruction.clientSubmissionId === identity.clientSubmissionId &&
    entry.receipt.receiptId === identity.receiptId &&
    entry.receipt.sessionKey === identity.sessionKey &&
    entry.receipt.sessionEpoch === identity.sessionEpoch;
}

function claimIdentityMatches(
  claim: WorkspaceTurnQueueClaim | null,
  identity: WorkspaceTurnQueueClaimIdentity,
): boolean {
  return !!claim &&
    claim.claimId === identity.claimId &&
    claim.sessionKey === identity.sessionKey &&
    claim.sessionEpoch === identity.sessionEpoch;
}

function replaceEntry(
  entries: readonly WorkspaceTurnQueueEntry[],
  index: number,
  entry: WorkspaceTurnQueueEntry,
): readonly WorkspaceTurnQueueEntry[] {
  const next = [...entries];
  next[index] = entry;
  return Object.freeze(next);
}

export function reduceWorkspaceTurnQueue(
  state: WorkspaceTurnQueueState,
  command: WorkspaceTurnQueueCommand,
): WorkspaceTurnQueueTransitionResult {
  if (!isValidEventTime(command.at)) return rejected(state, "invalid_command_time");

  if (command.type === "append") {
    const instruction = normalizeWorkspaceInstruction(command.instruction);
    if (!instruction) return rejected(state, "invalid_instruction");
    const receipt = normalizeWorkspaceInstructionReceipt(command.receipt);
    if (!receipt) return rejected(state, "invalid_receipt");
    if (!instructionMatchesReceipt(instruction, receipt)) {
      return rejected(state, "instruction_receipt_mismatch");
    }
    if (!commandOwnerMatches(state, instruction)) {
      return rejected(state, "queue_owner_mismatch");
    }
    const existing = state.entries.find((candidate) =>
      candidate.instruction.clientSubmissionId === instruction.clientSubmissionId
    );
    if (existing) {
      return instructionsEqual(existing.instruction, instruction) &&
        receiptsEqual(existing.receipt, receipt)
        ? idempotent(state, existing)
        : rejected(state, "client_submission_conflict", existing);
    }
    if (receipt.acceptedAt > command.at) return rejected(state, "invalid_command_time");
    if (!Number.isInteger(command.expectedVersion) || command.expectedVersion !== state.version) {
      return rejected(state, "version_conflict");
    }
    if (command.at < state.updatedAt) return rejected(state, "invalid_command_time");
    const entry = freezeEntry({
      instruction,
      receipt,
      status: "persisting",
      claim: null,
      enqueuedAt: command.at,
      persistedAt: null,
      updatedAt: command.at,
    });
    return applied(state, command.at, Object.freeze([...state.entries, entry]), entry);
  }

  if (!commandOwnerMatches(state, command)) {
    return rejected(state, "queue_owner_mismatch");
  }

  if (command.type === "claim") {
    const head = state.entries[0];
    if (head?.status === "dispatching" && claimIdentityMatches(head.claim, command)) {
      return idempotent(state, head);
    }
  } else if (command.type === "commit") {
    const existing = state.entries.find((candidate) => entryIdentityMatches(candidate, command));
    if (existing && existing.status !== "persisting") return idempotent(state, existing);
  }

  if (!Number.isInteger(command.expectedVersion) || command.expectedVersion !== state.version) {
    return rejected(state, "version_conflict");
  }
  if (command.at < state.updatedAt) return rejected(state, "invalid_command_time");

  switch (command.type) {
    case "commit": {
      const index = state.entries.findIndex((entry) => entryIdentityMatches(entry, command));
      if (index < 0) return rejected(state, "entry_not_found");
      const current = state.entries[index];
      if (current.status !== "persisting") {
        return rejected(state, "entry_state_conflict", current);
      }
      const entry = freezeEntry({
        ...current,
        status: "queued",
        persistedAt: command.at,
        updatedAt: command.at,
      });
      return applied(state, command.at, replaceEntry(state.entries, index, entry), entry);
    }
    case "claim": {
      if (!isRequiredIdentityPart(command.claimId)) {
        return rejected(state, "claim_id_mismatch");
      }
      const head = state.entries[0];
      if (!head) return rejected(state, "queue_empty");
      if (head.status === "persisting") return rejected(state, "head_persisting", head);
      if (head.status === "dispatching") return rejected(state, "head_dispatching", head);
      if (!commandOwnerMatches(state, head.receipt)) {
        return rejected(state, "queue_owner_mismatch", head);
      }
      const claim = Object.freeze({
        claimId: command.claimId,
        sessionKey: command.sessionKey,
        sessionEpoch: command.sessionEpoch,
        claimedAt: command.at,
      });
      const entry = freezeEntry({
        ...head,
        status: "dispatching",
        claim,
        updatedAt: command.at,
      });
      return applied(state, command.at, replaceEntry(state.entries, 0, entry), entry);
    }
    case "release": {
      const head = state.entries[0];
      if (!head) return rejected(state, "queue_empty");
      if (head.status !== "dispatching") return rejected(state, "entry_state_conflict", head);
      if (!claimIdentityMatches(head.claim, command)) {
        return rejected(state, "claim_id_mismatch", head);
      }
      const entry = freezeEntry({
        ...head,
        status: "queued",
        claim: null,
        updatedAt: command.at,
      });
      return applied(state, command.at, replaceEntry(state.entries, 0, entry), entry);
    }
    case "ack":
    case "remove": {
      const head = state.entries[0];
      if (!head) return rejected(state, "queue_empty");
      if (head.status !== "dispatching") return rejected(state, "entry_state_conflict", head);
      if (!claimIdentityMatches(head.claim, command)) {
        return rejected(state, "claim_id_mismatch", head);
      }
      const turnOwner = command.type === "ack" ? command.turnOwner : command.terminalOwner;
      if (!turnOwner ||
        turnOwner.sessionKey !== command.sessionKey ||
        turnOwner.sessionEpoch !== command.sessionEpoch ||
        turnOwner.turnId !== head.receipt.turnId
      ) return rejected(state, "terminal_owner_mismatch", head);
      return applied(state, command.at, Object.freeze(state.entries.slice(1)), head);
    }
    case "rollback": {
      const index = state.entries.findIndex((entry) => entryIdentityMatches(entry, command));
      if (index < 0) return rejected(state, "entry_not_found");
      const entry = state.entries[index];
      if (entry.status !== "persisting") {
        return rejected(state, "entry_state_conflict", entry);
      }
      return applied(
        state,
        command.at,
        Object.freeze(state.entries.filter((_, candidateIndex) => candidateIndex !== index)),
        entry,
      );
    }
    default:
      return rejected(state, "unknown_command");
  }
}

function normalizeClaim(
  value: unknown,
  sessionKey: string,
  sessionEpoch: string,
): WorkspaceTurnQueueClaim | null {
  if (!isRecord(value) ||
    !isRequiredIdentityPart(value.claimId) ||
    value.sessionKey !== sessionKey ||
    value.sessionEpoch !== sessionEpoch ||
    !isValidEventTime(value.claimedAt)
  ) return null;
  return Object.freeze({
    claimId: value.claimId,
    sessionKey,
    sessionEpoch,
    claimedAt: value.claimedAt,
  });
}

function normalizeQueueEntry(
  value: unknown,
  sessionKey: string,
  sessionEpoch: string,
): WorkspaceTurnQueueEntry | null {
  if (!isRecord(value)) return null;
  const instruction = normalizeWorkspaceInstruction(value.instruction);
  const receipt = normalizeWorkspaceInstructionReceipt(value.receipt);
  if (!instruction || !receipt ||
    !instructionMatchesReceipt(instruction, receipt) ||
    instruction.sessionKey !== sessionKey ||
    instruction.sessionEpoch !== sessionEpoch ||
    (value.status !== "persisting" && value.status !== "queued" && value.status !== "dispatching") ||
    !isValidEventTime(value.enqueuedAt) ||
    !isValidEventTime(value.updatedAt) ||
    value.enqueuedAt < receipt.acceptedAt ||
    value.updatedAt < value.enqueuedAt
  ) return null;

  const persistedAt = value.persistedAt === null
    ? null
    : isValidEventTime(value.persistedAt) ? value.persistedAt : undefined;
  if (persistedAt === undefined ||
    (persistedAt !== null && persistedAt < value.enqueuedAt) ||
    (value.status === "persisting" && persistedAt !== null) ||
    (value.status !== "persisting" && persistedAt === null)
  ) return null;

  const claim = value.status === "dispatching"
    ? normalizeClaim(value.claim, sessionKey, sessionEpoch)
    : null;
  if (value.status !== "dispatching" && value.claim !== null) return null;
  if (value.status === "dispatching" &&
    (!claim || claim.claimedAt < (persistedAt || 0) || claim.claimedAt > value.updatedAt)
  ) return null;

  return freezeEntry({
    instruction,
    receipt,
    status: value.status,
    claim,
    enqueuedAt: value.enqueuedAt,
    persistedAt,
    updatedAt: value.updatedAt,
  });
}

function isTerminalOwner(
  entry: WorkspaceTurnQueueEntry,
  terminalOwners: readonly WorkspaceTurnTerminalOwner[],
): boolean {
  return terminalOwners.some((owner) =>
    owner.sessionKey === entry.receipt.sessionKey &&
    owner.sessionEpoch === entry.receipt.sessionEpoch &&
    owner.turnId === entry.receipt.turnId
  );
}

/**
 * Reconcile a persisted queue after process loss. An entry visible in the
 * snapshot is durable, so both transient states become queued. Exact terminal
 * owners are removed to prevent replaying a Turn that already concluded.
 */
export function reconcileWorkspaceTurnQueueOnRestore(
  input: ReconcileWorkspaceTurnQueueOnRestoreInput,
): WorkspaceTurnQueueState {
  const at = input.at ?? Date.now();
  if (!isRequiredIdentityPart(input.sessionKey) || !isRequiredIdentityPart(input.sessionEpoch)) {
    throw new Error("Workspace Turn queue restore requires an exact Session owner.");
  }
  if (!isValidEventTime(at)) {
    throw new Error("Workspace Turn queue restore requires a finite non-negative time.");
  }
  if (!isRecord(input.snapshot) ||
    input.snapshot.schemaVersion !== WORKSPACE_TURN_QUEUE_SCHEMA_VERSION ||
    input.snapshot.sessionKey !== input.sessionKey ||
    input.snapshot.sessionEpoch !== input.sessionEpoch ||
    !Number.isInteger(input.snapshot.version) || Number(input.snapshot.version) < 0 ||
    !isValidEventTime(input.snapshot.updatedAt) ||
    !Array.isArray(input.snapshot.entries)
  ) {
    return createWorkspaceTurnQueueState({
      sessionKey: input.sessionKey,
      sessionEpoch: input.sessionEpoch,
      updatedAt: at,
    });
  }

  const terminalOwners = (input.terminalOwners || []).filter((owner) =>
    owner && isRequiredIdentityPart(owner.sessionKey) &&
    isRequiredIdentityPart(owner.sessionEpoch) && isRequiredIdentityPart(owner.turnId)
  );
  const entries: WorkspaceTurnQueueEntry[] = [];
  const seenSubmissionIds = new Set<string>();
  let changed = false;

  for (const rawEntry of input.snapshot.entries) {
    const normalized = normalizeQueueEntry(rawEntry, input.sessionKey, input.sessionEpoch);
    if (!normalized) {
      changed = true;
      continue;
    }
    if (seenSubmissionIds.has(normalized.instruction.clientSubmissionId)) {
      changed = true;
      continue;
    }
    seenSubmissionIds.add(normalized.instruction.clientSubmissionId);
    if (isTerminalOwner(normalized, terminalOwners)) {
      changed = true;
      continue;
    }
    if (normalized.status === "persisting" || normalized.status === "dispatching") {
      changed = true;
      entries.push(freezeEntry({
        ...normalized,
        status: "queued",
        claim: null,
        persistedAt: normalized.persistedAt ?? Math.max(normalized.enqueuedAt, at),
        updatedAt: Math.max(normalized.updatedAt, at),
      }));
      continue;
    }
    entries.push(normalized);
  }

  const snapshotVersion = input.snapshot.version as number;
  const snapshotUpdatedAt = input.snapshot.updatedAt as number;
  return freezeState({
    schemaVersion: WORKSPACE_TURN_QUEUE_SCHEMA_VERSION,
    version: snapshotVersion + (changed ? 1 : 0),
    sessionKey: input.sessionKey,
    sessionEpoch: input.sessionEpoch,
    entries: Object.freeze(entries),
    updatedAt: changed ? Math.max(snapshotUpdatedAt, at) : snapshotUpdatedAt,
  });
}
