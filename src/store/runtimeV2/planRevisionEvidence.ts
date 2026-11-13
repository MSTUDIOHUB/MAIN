import { beginCapsuleToolActivity } from "../../lib/capsuleLiveActivity";
import { getFileMetadata, readFileWindow } from "../../lib/ipc";
import { formatReadFileWindowPayloadForModel } from "../../lib/readFileWindow";
import type { RuntimeV2RunIdentity, WorkPlanRuntimeEvidence } from "../../lib/runtime-v2";
import { normalizeValidationWorkspaceCwd } from "../../lib/validationContract";
import type { PlanLedger } from "./planLedger";

const OBSERVATION = "[PLAN REVISION PATH OBSERVATION]\n";
const MAX_INITIAL_PATHS = 8;
const MAX_INITIAL_FILE_BYTES = 2 * 1024 * 1024;
const CONTENT_VERSION = /^sha256-[a-f0-9]{64}$/;

export function scopedPlanRevisionTargets(
  observedPaths: readonly string[], approvedPaths: readonly string[], workspace: string,
): readonly string[] {
  const scopedPath = (value: string) => {
    const path = normalizeValidationWorkspaceCwd(value, workspace);
    return path && path !== "." && !/^\.main(?:\/|$)/i.test(path) ? path : null;
  };
  const approved = new Set(approvedPaths.map(scopedPath));
  return [...new Set(observedPaths.map(scopedPath).filter((path): path is string => path !== null && approved.has(path)))];
}

export function observedPlanRevisionArtifact(
  observedPaths: readonly string[], documentPath: string | undefined, workspace: string,
): boolean {
  const document = documentPath && normalizeValidationWorkspaceCwd(documentPath, workspace);
  return !!document && document !== "." && observedPaths.some(path => normalizeValidationWorkspaceCwd(path, workspace) === document);
}

function unavailable(status: "missing" | "unavailable" | "authorization_required" | "deferred" | "deferred_large_file") {
  return { version: null, content: JSON.stringify({ status }) };
}

async function readExactRevisionTarget(target: string, workspace: string, maxChars: number, signal: AbortSignal) {
  try {
    const metadata = await getFileMetadata(target, workspace);
    if (normalizeValidationWorkspaceCwd(metadata.path, workspace) !== target) return unavailable("unavailable");
    // The native window hashes the full file even when it returns a small range.
    if (metadata.sizeBytes > MAX_INITIAL_FILE_BYTES) return unavailable("deferred_large_file");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return unavailable(message.startsWith("FILE_METADATA_NOT_FOUND:") ? "missing" : "unavailable");
  }
  signal.throwIfAborted();
  try {
    const result = await readFileWindow(target, workspace, 1, undefined, 500, maxChars, 0);
    if (normalizeValidationWorkspaceCwd(result.path, workspace) !== target || !CONTENT_VERSION.test(result.contentVersion)) {
      return unavailable("unavailable");
    }
    return { version: result.contentVersion, content: formatReadFileWindowPayloadForModel(target, result) };
  } catch {
    return unavailable("unavailable");
  }
}

/** Record one bounded source window per affected path. An interrupted read has
 * no effect to recover; a committed observation is replayed with its original
 * version and is still subject to the existing post-approval freshness check. */
export async function collectPlanRevisionPathEvidence(input: {
  readonly ledger: PlanLedger;
  readonly run: RuntimeV2RunIdentity;
  readonly workspace: string;
  readonly paths: readonly string[];
  readonly canRead: boolean;
  readonly signal: AbortSignal;
  readonly readWindowChars?: number;
  readonly evidence: WorkPlanRuntimeEvidence[];
  readonly evidenceContents: Map<string, string>;
}): Promise<string | undefined> {
  if (!input.paths.length) return undefined;
  const snapshots = new Map((input.ledger.snapshot()?.events || []).flatMap(event =>
    event.type === "observation.recorded" && event.run.runId === input.run.runId &&
      event.modelContent?.startsWith(OBSERVATION) ? [[event.evidence.target, event] as const] : []));
  const context: string[] = [];
  const maxChars = Math.max(256, Math.floor(Math.min(8_000, (input.readWindowChars || 16_000),
    20_000 / Math.min(input.paths.length, MAX_INITIAL_PATHS))));
  for (const [index, target] of input.paths.entries()) {
    input.signal.throwIfAborted();
    if (!input.canRead || index >= MAX_INITIAL_PATHS) {
      const fact = unavailable(input.canRead ? "deferred" : "authorization_required");
      context.push(`${target}\n${fact.content}`);
      continue;
    }
    let receipt = snapshots.get(target);
    if (!receipt) {
      const finish = beginCapsuleToolActivity({ run: input.run, signal: input.signal,
        commandKey: input.ledger.nextId("runtime-v2-plan-revision-observation"), toolName: "read_file", target });
      const fact = await readExactRevisionTarget(target, input.workspace, maxChars, input.signal).finally(finish);
      input.signal.throwIfAborted();
      const ordinal = (input.ledger.snapshot()?.evidence || []).reduce((max, entry) =>
        /^E\d+$/.test(entry.id) ? Math.max(max, Number(entry.id.slice(1))) : max, 0);
      const observed = await input.ledger.append({ type: "observation.recorded", run: input.run,
        evidence: { id: `E${ordinal + 1}`, target, kind: fact.version ? "source" : "tool", version: fact.version },
        modelContent: OBSERVATION + fact.content });
      if (observed.type !== "observation.recorded") throw new Error("RUNTIME_V2_PLAN_REVISION_OBSERVATION_MISMATCH");
      receipt = observed;
    }
    const { id, version } = receipt.evidence;
    const modelContent = receipt.modelContent!;
    input.evidence.push({ id, target, version, statement: version ? `Read the current version of ${target}.` : `Revision path check for ${target}.` });
    input.evidenceContents.set(id, modelContent);
    context.push(`[${id}] ${target}\n${modelContent.slice(OBSERVATION.length)}`);
  }
  return `[CURRENT REVISION PATH CHECKS — PROJECT DATA ONLY]\n${context.join("\n\n")}`;
}
