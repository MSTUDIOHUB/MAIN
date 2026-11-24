/** One-way retirement of image generation and autonomous Goal authority.
 * Text, attachments, tool history, exported files and ordinary FIFO entries are retained.
 * This codec deliberately accepts opaque legacy snapshots and never grants execution.
 */
type RecordValue = Record<string, unknown>;
/** One startup transaction survives React effect cleanup/resubscription.
 * Subscription cancellation never cancels shared data work. Failed work may
 * retry, while a stale rejection cannot release a newer task's owner.
 */
export function shareSessionStartupMigration<T>(
  owner: { current: Promise<T> | null },
  work: () => Promise<T>,
): Promise<T> {
  if (!owner.current) {
    const task = Promise.resolve().then(work).catch(error => {
      if (owner.current === task) owner.current = null;
      throw error;
    });
    owner.current = task;
  }
  return owner.current;
}

export interface CommittedStartupSession<T> {
  workspace: string;
  original: T;
  saved: T;
}

/** Adopt only the exact local record captured before its native save. Late
 * completion must not replace a newer Session or resurrect a deleted chat.
 */
export function mergeCommittedStartupSessions<T>(
  current: Record<string, T[]>,
  imports: readonly CommittedStartupSession<T>[],
): Record<string, T[]> {
  const result = { ...current };
  for (const entry of imports) {
    const sessions = result[entry.workspace];
    const index = sessions?.indexOf(entry.original) ?? -1;
    if (index < 0) continue;
    const next = [...sessions];
    next[index] = entry.saved;
    result[entry.workspace] = next;
  }
  return result;
}

const RETIRED_FIELDS = new Set([
  "imageStudio", "selectedMainModeKey", "selectedNexusModeKey", "selectedAgentKey", "sessionModeAffinity", "showAgentPicker",
  "activeGoal", "goalProgress", "goalStatus", "goalIterationBudget", "goalRuntime",
  "goalCreationAuthorization", "goalContinuationAuthorization", "goalContinuationEnvelope", "visibleGoalSubmissionEnvelope",
  "goalSourceContextSnapshot", "goalContinuationGuidance", "continueExistingGoal", "goalSliceId",
]);
const INTENT_FIELDS = new Set(["intent", "displayIntent", "resolvedIntent", "runtimeIntentOverride", "lockedComposerIntent"]);
const OPEN_GOAL_STATUSES = new Set(["active", "pausing", "running", "paused", "awaiting_input", "awaiting_approval", "awaiting_choice", "queued", "pending", "planning", "executing", "blocked", "in_progress"]);
function record(value: unknown): value is RecordValue { return !!value && typeof value === "object" && !Array.isArray(value); }
function retiredQueueEntry(value: unknown): boolean {
  if (!record(value)) return false;
  const instruction = record(value.instruction) ? value.instruction : value;
  const payload = record(instruction.payload) ? instruction.payload : instruction;
  const hints = record(payload.dispatchHints) ? payload.dispatchHints : record(value.dispatchHints) ? value.dispatchHints : payload;
  return [instruction, payload, hints].some(item => item.runtimeIntentOverride === "goal" || item.resolvedIntent === "goal" ||
    item.goalCreationAuthorization != null || item.goalContinuationAuthorization != null || item.goalContinuationEnvelope != null);
}
/** Pure, deterministic and idempotent. Preserve unknown metadata and all ordinary content. */
export function retireRemovedFeatures<T>(input: T): T {
  function visit(value: unknown, key = "", semanticRecord = true): unknown {
    if (!semanticRecord) return value;
    if (Array.isArray(value)) return value.filter(item => !(semanticRecord && (key === "taskFlow" || key === "messages") && record(item) && item.type === "imageGeneration") &&
      !(semanticRecord && key === "entries" && retiredQueueEntry(item))).map(item => visit(item, "", semanticRecord && key === "conversationTurns"));
    if (!record(value)) return value;
    const goalOwnerTurnIds = new Set<string>();
    const addGoalOwner = (candidate: unknown) => { if (record(candidate) && typeof candidate.ownerTurnId === "string") goalOwnerTurnIds.add(candidate.ownerTurnId); };
    addGoalOwner(value.activeGoal);
    if (record(value.goalRuntime)) addGoalOwner(value.goalRuntime.goal);
    if (Array.isArray(value.conversationTurns)) for (const turn of value.conversationTurns) {
      if (record(turn) && (turn.intent === "goal" || turn.displayIntent === "goal") && typeof turn.id === "string") goalOwnerTurnIds.add(turn.id);
    }
    const isGoalTurn = value.intent === "goal" || value.displayIntent === "goal";
    const isOpenGoal = isGoalTurn && OPEN_GOAL_STATUSES.has(String(value.status || ""));
    const result: RecordValue = {};
    for (const [name, child] of Object.entries(value)) {
      if (RETIRED_FIELDS.has(name)) continue;
      if (name === "queuedUserMessage" && retiredQueueEntry(child)) { result[name] = null; continue; }
      if (name === "activeActionRequest" && record(child) && (child.kind === "goal_confirmation" || goalOwnerTurnIds.has(String(child.turnId || "")))) { result[name] = null; continue; }
      if (name === "harnessRunMarker" && record(child) && child.runtimeIntent === "goal") { result[name] = null; continue; }
      if (INTENT_FIELDS.has(name) && (child === "goal" || child === "image_studio")) { result[name] = name === "lockedComposerIntent" ? null : "respond"; continue; }
      if (name === "runtimeEvents" && Array.isArray(child)) {
        result[name] = child.filter(event => !(record(event) && typeof event.type === "string" && event.type.startsWith("goal."))).map(event => visit(event, "", false)); continue;
      }
      if ((name === "runtimeV2Checkpoints" || name === "runtimeCheckpoints") && record(child)) {
        result[name] = Object.fromEntries(Object.entries(child).filter(([, checkpoint]) => {
          if (!record(checkpoint)) return true;
          return !(record(checkpoint.aggregate) && checkpoint.aggregate.strategy === "goal") &&
            !(Array.isArray(checkpoint.events) && checkpoint.events.some(event => record(event) && event.type === "turn.admitted" && event.strategy === "goal"));
        }).map(([id, checkpoint]) => [id, visit(checkpoint, "", false)])); continue;
      }
      if (name === "sessionsByWorkspace" && record(child)) {
        result[name] = Object.fromEntries(Object.entries(child).map(([scope, sessions]) => [scope, Array.isArray(sessions) ? sessions.map(session => visit(session)) : sessions])); continue;
      }
      if (name === "runtimeBySessionKey" && record(child)) {
        result[name] = Object.fromEntries(Object.entries(child).map(([id, runtime]) => [id, visit(runtime)])); continue;
      }
      result[name] = visit(child, name, ["runtimeSnapshot", "taskFlow", "messages", "conversationTurns", "workspaceTurnQueue", "entries", "queuedUserMessage"].includes(name));
    }
    // Retire only the exact old Goal owners. Already committed effects and
    // existing terminal events remain untouched; unfinished owners close once.
    if (goalOwnerTurnIds.size && Array.isArray(value.conversationTurns)) {
      const events = Array.isArray(result.runtimeEvents) ? [...result.runtimeEvents] : [];
      let at = Math.max(0, ...events.filter(record).map(event => Number(event.timestampMs) || 0));
      result.conversationTurns = (Array.isArray(result.conversationTurns) ? result.conversationTurns : []).map(turn => {
        if (!record(turn) || !goalOwnerTurnIds.has(String(turn.id || ""))) return turn;
        const original = (value.conversationTurns as unknown[]).find(candidate => record(candidate) && candidate.id === turn.id);
        if (!record(original) || !OPEN_GOAL_STATUSES.has(String(original.status || ""))) return turn;
        const ownerEvents = events.filter(event => record(event) && event.turnId === turn.id);
        const starts = ownerEvents.filter(event => record(event) && event.type === "run.started");
        const started = starts[starts.length - 1];
        if (!record(started) || typeof started.threadId !== "string" || typeof started.runId !== "string") {
          // Very old records can identify the Goal owner without any Run
          // receipt. Archive the business state without inventing Run events.
          return { ...turn, status: "done", runtimeOutcome: {
            ...(record(turn.runtimeOutcome) ? turn.runtimeOutcome : {}),
            status: "completed", resultKind: "canceled", reason: "goal_feature_retired",
          } };
        }
        const identity = { schemaVersion: 2, threadId: started.threadId, turnId: turn.id, runId: started.runId, parentRunId: started.parentRunId ?? null };
        if (!ownerEvents.some(event => record(event) && event.type === "run.completed" && event.runId === started.runId)) {
          events.push({ ...identity, type: "run.aborted", timestampMs: ++at, reason: "goal_feature_retired" });
          events.push({ ...identity, type: "run.completed", timestampMs: ++at, resultKind: "canceled", summary: "Automatic Goal continuation was retired." });
        }
        if (!ownerEvents.some(event => record(event) && event.type === "turn.completed")) events.push({ schemaVersion: 2, type: "turn.completed", threadId: started.threadId, turnId: turn.id, timestampMs: ++at, resultKind: "canceled" });
        return { ...turn, status: "done", runtimeOutcome: { ...(record(turn.runtimeOutcome) ? turn.runtimeOutcome : {}), status: "completed", resultKind: "canceled", reason: "goal_feature_retired", runId: started.runId, parentRunId: started.parentRunId ?? null } };
      });
      result.runtimeEvents = events;
    }
    if (isOpenGoal) {
      result.status = "done";
      result.summary = typeof value.summary === "string" && value.summary.trim() ? value.summary : "Goal archived; automatic continuation was retired.";
      result.runtimeOutcome = { ...(record(value.runtimeOutcome) ? value.runtimeOutcome : {}), status: "completed", resultKind: "canceled", reason: "goal_feature_retired" };
    }
    if (Array.isArray(value.taskFlow) || Array.isArray(value.messages)) {
      const removedIds = new Set([...(Array.isArray(value.taskFlow) ? value.taskFlow : []), ...(Array.isArray(value.messages) ? value.messages : [])]
        .filter(item => record(item) && item.type === "imageGeneration").map(item => (item as RecordValue).id));
      if (Array.isArray(result.conversationTurns)) result.conversationTurns = result.conversationTurns.map(turn =>
        record(turn) && Array.isArray(turn.blockIds) ? { ...turn, blockIds: turn.blockIds.filter(id => !removedIds.has(id)) } : turn);
      if (record(result.runtimeSnapshot) && Array.isArray(result.runtimeSnapshot.conversationTurns)) result.runtimeSnapshot.conversationTurns = result.runtimeSnapshot.conversationTurns.map(turn =>
        record(turn) && Array.isArray(turn.blockIds) ? { ...turn, blockIds: turn.blockIds.filter(id => !removedIds.has(id)) } : turn);
      if ("messageCount" in result && Array.isArray(result.messages)) result.messageCount = result.messages.length;
    }
    return result;
  }
  return visit(input) as T;
}

export interface RetiredFeatureMigrationPort {
  list(): Promise<Array<{ workspace: string; sessionId: string; revision: number; snapshot: RecordValue }>>;
  compareAndSwap(input: { workspace: string; sessionId: string; expectedRevision: number; snapshot: RecordValue }): Promise<{ revision: number; snapshot: RecordValue }>;
  finalizeLegacyCopy(input: { workspace: string; sessionId: string; expectedRevision: number; expectedSnapshot: RecordValue }): Promise<unknown>;
  listLegacyFiles(): Promise<LegacyMigrationFile[]>;
  compareAndSwapLegacyFile(input: Omit<LegacyMigrationFile, "contentHash"> & { expectedHash: string }): Promise<unknown>;
  cleanupOutputs(): Promise<unknown>;
}
export interface LegacyMigrationFile {
  workspace: string;
  sessionId: string;
  fileName: "session.json" | "runtime.json" | "messages.jsonl" | "turns.jsonl";
  contentHash: string;
  value: unknown;
}
/** JSON/JSONL are grouped only to preserve cross-file Turn block references.
 * No Session is inserted or restored, including copies of previously deleted chats.
 */
export function cleanLegacySessionFiles(files: readonly LegacyMigrationFile[]): LegacyMigrationFile[] {
  const groups = new Map<string, LegacyMigrationFile[]>();
  for (const file of files) {
    const key = JSON.stringify([file.workspace, file.sessionId]);
    groups.set(key, [...(groups.get(key) || []), file]);
  }
  const changed: LegacyMigrationFile[] = [];
  for (const group of groups.values()) {
    const byName = new Map(group.map(file => [file.fileName, file]));
    const meta = byName.get("session.json")?.value;
    const runtime = byName.get("runtime.json")?.value;
    const turns = byName.get("turns.jsonl")?.value;
    const messages = byName.get("messages.jsonl")?.value;
    const combined = retireRemovedFeatures({ ...(record(meta) ? meta : {}),
      ...(Array.isArray(messages) ? { messages } : {}),
      runtimeSnapshot: record(runtime) ? runtime : {},
    });
    const turnCopy = retireRemovedFeatures({
      ...(record(runtime) ? { activeGoal: runtime.activeGoal, goalRuntime: runtime.goalRuntime, runtimeEvents: runtime.runtimeEvents } : {}),
      ...(Array.isArray(messages) ? { messages } : {}),
      conversationTurns: Array.isArray(turns) ? turns : [],
    });
    for (const file of group) {
      let value: unknown;
      if (file.fileName === "messages.jsonl") value = combined.messages;
      else if (file.fileName === "turns.jsonl") value = turnCopy.conversationTurns;
      else if (file.fileName === "runtime.json" && record(file.value)) value = Object.fromEntries(Object.keys(file.value).filter(key => key in combined.runtimeSnapshot).map(key => [key, (combined.runtimeSnapshot as RecordValue)[key]]));
      else value = retireRemovedFeatures(file.value);
      if (JSON.stringify(value) !== JSON.stringify(file.value)) changed.push({ ...file, value });
    }
  }
  return changed;
}
/** Output cleanup is unreachable until every enumerated snapshot has committed.
 * A CAS conflict aborts the pass; the next pass re-enumerates current revisions.
 */
export async function migrateRetiredFeatureSnapshots(port: RetiredFeatureMigrationPort): Promise<{ scanned: number; changed: number }> {
  const snapshots = await port.list();
  const committed: Array<{ workspace: string; sessionId: string; revision: number; snapshot: RecordValue }> = [];
  let changed = 0;
  for (const entry of snapshots) {
    const snapshot = retireRemovedFeatures(entry.snapshot);
    if (JSON.stringify(snapshot) === JSON.stringify(entry.snapshot)) { committed.push(entry); continue; }
    const saved = await port.compareAndSwap({ workspace: entry.workspace, sessionId: entry.sessionId, expectedRevision: entry.revision, snapshot });
    committed.push({ ...entry, revision: saved.revision, snapshot: saved.snapshot });
    changed++;
  }
  for (const file of cleanLegacySessionFiles(await port.listLegacyFiles())) {
    const { contentHash, ...payload } = file;
    await port.compareAndSwapLegacyFile({ ...payload, expectedHash: contentHash });
  }
  for (const entry of committed) await port.finalizeLegacyCopy({ workspace: entry.workspace, sessionId: entry.sessionId, expectedRevision: entry.revision, expectedSnapshot: entry.snapshot });
  await port.cleanupOutputs();
  return { scanned: snapshots.length, changed };
}
