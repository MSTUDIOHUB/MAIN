import { canonicalJson } from "../canonicalJson";
import { normalizeRuntimeV2CheckpointMap, sameRuntimeV2CheckpointOwner, type RuntimeV2CheckpointMap } from "./checkpoint";

export class RuntimeV2CheckpointForkError extends Error {
  readonly code = "runtime_v2_checkpoint_fork";

  constructor() {
    super("A Session save tried to replace a canonical Turn with a different event history.");
  }
}

export function mergeRuntimeV2CheckpointMaps(current: unknown, incoming: unknown): RuntimeV2CheckpointMap {
  const existing = normalizeRuntimeV2CheckpointMap(current, undefined, { rejectInvalid: true });
  const updates = normalizeRuntimeV2CheckpointMap(incoming, undefined, { rejectInvalid: true });
  const merged = new Map(Object.entries(existing));
  for (const [turnId, next] of Object.entries(updates)) {
    const previous = merged.get(turnId);
    if (!previous) {
      merged.set(turnId, next);
      continue;
    }
    if (!sameRuntimeV2CheckpointOwner(previous.owner, next.owner)) throw new RuntimeV2CheckpointForkError();
    const [older, newer] = previous.revision <= next.revision ? [previous, next] : [next, previous];
    if (older.aggregateDigest !== newer.aggregateDigest && (
      older.revision === newer.revision || older.events.length >= newer.events.length ||
      older.events.some((event, index) => event !== newer.events[index] && canonicalJson(event) !== canonicalJson(newer.events[index]))
    )) throw new RuntimeV2CheckpointForkError();
    merged.set(turnId, newer);
  }
  return Object.fromEntries(merged);
}
