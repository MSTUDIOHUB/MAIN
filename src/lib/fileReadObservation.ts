/**
 * Persistable identity of source evidence returned by a file read.
 *
 * This contract is shared by collaboration/history projections. Cache
 * ownership and replay policy belong to an execution runtime and are
 * intentionally absent.
 */
export type FileReadObservationSource = "fresh" | "stub" | "replay";

export interface FileReadWindowIdentity {
  startLine: number;
  endLine: number;
  totalLines: number;
  truncated: boolean;
}

export interface FileReadObservationIdentity {
  key: string;
  path: string;
  requestSignature: string;
  versionToken: string;
  contentHash?: string;
  source: FileReadObservationSource;
  /** Actual returned source range, not merely the model-requested range. */
  window?: FileReadWindowIdentity;
}
