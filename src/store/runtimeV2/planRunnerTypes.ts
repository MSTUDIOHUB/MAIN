import type { RuntimeV2SubmissionContext } from "./submissionContext";
import type { SubmitSessionPersistence } from "../persistSubmitRuntimeProjection";

type StoreGet = () => any;
type StoreSet = (patchOrUpdater: any) => void;

export interface RuntimeV2PlanRunnerInput {
  readonly lifecycleDeadlineAt?: number;
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
  readonly persistSessionRecord: SubmitSessionPersistence;
  readonly logStoreEvent: (
    event: string,
    data?: Record<string, unknown>,
  ) => void;
}
