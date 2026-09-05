import { sha256Hex } from "../sha256";
import type { RuntimeV2SubagentJob } from "./contracts";

const CHILD_EVIDENCE_FINGERPRINT_LENGTH = 32;

/**
 * A compact, provider-facing evidence identity bound to the complete child Run
 * rather than the presentation-level job id. Consumers treat persisted legacy
 * ids as opaque strings, so no checkpoint migration is required.
 */
export function runtimeV2ChildEvidenceId(
  job: RuntimeV2SubagentJob,
  ordinal: number,
): string {
  if (!Number.isInteger(ordinal) || ordinal < 1) {
    throw new Error("RUNTIME_V2_CHILD_EVIDENCE_ORDINAL_INVALID");
  }
  const identity = JSON.stringify([
    "runtime-v2-child-evidence.v1",
    job.run.sessionKey,
    job.run.sessionEpoch,
    job.run.turnId,
    job.run.runId,
    job.run.parentRunId,
    job.run.attemptId,
    job.parentRunId,
    job.id,
  ]);
  const fingerprint = sha256Hex(identity).slice(
    0,
    CHILD_EVIDENCE_FINGERPRINT_LENGTH,
  );
  return `child:${fingerprint}:E${ordinal}`;
}
