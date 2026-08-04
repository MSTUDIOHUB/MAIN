import type { RuntimeV2SubmissionContext } from "./submissionContext";

type StoreGet = () => any;
type StoreSet = (patchOrUpdater: any) => void;

export interface RuntimeV2PlanRunnerInput {
  readonly get: StoreGet;
  readonly set: StoreSet;
  readonly context: RuntimeV2SubmissionContext;
  readonly getSessionRevisionToken: () => unknown;
  readonly sanitizeTaskBlocksForPersist: (blocks: any[]) => any[];
  readonly buildSessionRuntimeSnapshot: (state: any) => unknown;
  readonly publishOwnerScopedRuntimeProjection: (input: {
    projectedState: any;
    durableState?: any;
    scopeKey: string;
    sessionId: number | string | null | undefined;
    expectedRevisionToken: unknown;
  }) => { published: boolean; disposition: string };
  readonly persistSessionRecord: (
    scopeKey: string,
    session: unknown,
  ) => Promise<unknown>;
  readonly logStoreEvent: (
    event: string,
    data?: Record<string, unknown>,
  ) => void;
}
