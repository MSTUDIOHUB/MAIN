import type { AgentLoopOutcome } from "./runOutcome";

export interface RuntimeRunSettlementIdentity {
  readonly sessionKey: string;
  readonly turnId: string;
  readonly runId: string;
  readonly parentRunId: string | null;
  readonly outerRunId: string;
}

export interface RuntimeRunSettlementOwnerSnapshot {
  readonly harnessRunId: string | null;
  readonly actionRunId: string | null;
  readonly actionRequestRunId: string | null;
  readonly sessionKey: string | null;
  readonly turnId: string | null;
  readonly status: string | null;
  readonly instanceId: string | null;
  readonly startedAt: number | null;
}

/**
 * Composition-boundary result shared by both runtime generations.  It lives
 * outside any executor implementation so replacing a runner cannot change the
 * submission owner's settlement contract.
 */
export type RuntimeRunSettlement =
  | {
      readonly disposition: "projected";
      readonly reason: string;
      readonly identity: RuntimeRunSettlementIdentity;
      readonly outcome: AgentLoopOutcome;
    }
  | {
      readonly disposition: "superseded";
      readonly reason: string;
      readonly identity: RuntimeRunSettlementIdentity;
      readonly outcome: AgentLoopOutcome;
      readonly currentOwner: RuntimeRunSettlementOwnerSnapshot;
    }
  | {
      readonly disposition: "projection_failed";
      readonly reason: string;
      readonly identity: RuntimeRunSettlementIdentity;
      readonly outcome: AgentLoopOutcome;
      readonly currentOwner: RuntimeRunSettlementOwnerSnapshot;
    };
