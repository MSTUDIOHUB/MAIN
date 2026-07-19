import {
  canonicalizePlanArtifactPath,
  type PlanArtifact,
} from "./workflowModels";

// tasks.md is an execution/checkpoint artifact created after approval. Binding
// it into the reviewed design hash would invalidate a valid approval whenever
// task evidence changes. Only user-reviewable plan/design artifacts participate.
const REVIEWABLE_KINDS = new Set(["plan", "design", "bugfix"]);

export interface PlanApprovalIdentity {
  revision: number;
  artifactHash: string;
  artifactPaths: string[];
  artifactCount: number;
}

const SHA256_INITIAL_STATE = [
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
  0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
] as const;

const SHA256_ROUND_CONSTANTS = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5,
  0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc,
  0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
  0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3,
  0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5,
  0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
] as const;

function rotateRight(value: number, count: number): number {
  return (value >>> count) | (value << (32 - count));
}

/** Browser-safe synchronous SHA-256 used for approval capability identity. */
function sha256Hex(input: string): string {
  const bytes = new TextEncoder().encode(input);
  const paddedLength = Math.ceil((bytes.length + 9) / 64) * 64;
  const padded = new Uint8Array(paddedLength);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const bitLength = bytes.length * 8;
  const view = new DataView(padded.buffer);
  view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x1_0000_0000), false);
  view.setUint32(paddedLength - 4, bitLength >>> 0, false);

  const state: number[] = [...SHA256_INITIAL_STATE];
  const schedule = new Uint32Array(64);
  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let index = 0; index < 16; index += 1) {
      schedule[index] = view.getUint32(offset + index * 4, false);
    }
    for (let index = 16; index < 64; index += 1) {
      const previous15 = schedule[index - 15];
      const previous2 = schedule[index - 2];
      const sigma0 = rotateRight(previous15, 7) ^ rotateRight(previous15, 18) ^ (previous15 >>> 3);
      const sigma1 = rotateRight(previous2, 17) ^ rotateRight(previous2, 19) ^ (previous2 >>> 10);
      schedule[index] = (schedule[index - 16] + sigma0 + schedule[index - 7] + sigma1) >>> 0;
    }

    let [a, b, c, d, e, f, g, h] = state;
    for (let index = 0; index < 64; index += 1) {
      const sum1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
      const choice = (e & f) ^ (~e & g);
      const temporary1 = (h + sum1 + choice + SHA256_ROUND_CONSTANTS[index] + schedule[index]) >>> 0;
      const sum0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const temporary2 = (sum0 + majority) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + temporary1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temporary1 + temporary2) >>> 0;
    }
    state[0] = (state[0] + a) >>> 0;
    state[1] = (state[1] + b) >>> 0;
    state[2] = (state[2] + c) >>> 0;
    state[3] = (state[3] + d) >>> 0;
    state[4] = (state[4] + e) >>> 0;
    state[5] = (state[5] + f) >>> 0;
    state[6] = (state[6] + g) >>> 0;
    state[7] = (state[7] + h) >>> 0;
  }
  return state.map((value) => value.toString(16).padStart(8, "0")).join("");
}

export function buildPlanExecutionInstructionHash(instruction: string): string {
  return `plan-instruction-sha256-${sha256Hex(String(instruction))}`;
}

export function getReviewablePlanArtifacts(artifacts: PlanArtifact[]): PlanArtifact[] {
  return (artifacts || [])
    .filter((artifact) => REVIEWABLE_KINDS.has(artifact.kind) && String(artifact.content || "").trim())
    .map((artifact) => ({
      ...artifact,
      path: canonicalizePlanArtifactPath(artifact.path),
    }))
    .slice()
    .sort((left, right) => left.path.localeCompare(right.path));
}

export function buildPlanApprovalIdentity(
  artifacts: PlanArtifact[],
): PlanApprovalIdentity | null {
  const reviewable = getReviewablePlanArtifacts(artifacts);
  if (reviewable.length === 0) return null;
  const revision = reviewable.reduce(
    (max, artifact) => Math.max(max, Number(artifact.revision) || 1),
    1,
  );
  const canonical = reviewable
    .map((artifact) => [
      artifact.kind,
      artifact.path,
      String(Number(artifact.revision) || 1),
      String(artifact.content || "").replace(/\r\n?/g, "\n").trim(),
    ].join("\u001f"))
    .join("\u001e");
  return {
    revision,
    artifactHash: `plan-sha256-${sha256Hex(canonical)}`,
    artifactPaths: reviewable.map((artifact) => artifact.path),
    artifactCount: reviewable.length,
  };
}

export function isPlanApprovalIdentityCurrent(input: {
  artifacts: PlanArtifact[];
  revision?: number | null;
  artifactHash?: string | null;
}): boolean {
  const current = buildPlanApprovalIdentity(input.artifacts);
  if (!current || !input.artifactHash) return false;
  return current.artifactHash === input.artifactHash &&
    (input.revision == null || current.revision === input.revision);
}
