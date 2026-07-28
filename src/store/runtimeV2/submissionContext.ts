import type { ResolvedRunIntent } from "../../lib/runIntent";
import type { TurnInputContextSignals } from "../../lib/turnIntake";
import type {
  GoalContinuationAuthorization,
  GoalCreationAuthorization,
} from "../../lib/submit/turnSubmission";

/**
 * Immutable admission facts consumed by Runtime v2 runners.
 *
 * This intentionally excludes every mutable stream field owned by the legacy
 * the former executor. The submission adapter may pass a wider object because
 * TypeScript is structurally typed, but Runtime v2 cannot observe or mutate
 * those legacy fields through this boundary.
 */
export interface RuntimeV2SubmissionContext {
  readonly turnId: string;
  readonly uiDisplayTurnId: string;
  readonly runWorkspace: string | undefined;
  readonly runSessionKey: string;
  readonly runSessionId: number | null | undefined;
  readonly runScopeKey: string;
  readonly phaseLanguage: "zh" | "en";
  readonly effectiveRunIntent: ResolvedRunIntent;
  readonly runtimeRunIntent: ResolvedRunIntent;
  readonly goalCreationAuthorization?: GoalCreationAuthorization | null;
  readonly goalContinuationAuthorization?: GoalContinuationAuthorization | null;
  readonly abortCtrl: AbortController;
  readonly timerInterval: unknown;
  readonly harnessRunId: string;
  readonly turnInputContextSignals: TurnInputContextSignals;
  /** Optional parent-owned objective slice. Goal execution must preserve the
   * original criterion ids instead of re-admitting a synthesized prompt as
   * an anonymous Execute request. */
  readonly executeAdmission?: {
    readonly objective: string;
    readonly constraints?: readonly string[];
    readonly acceptanceCriteria: readonly {
      readonly id: string;
      readonly text: string;
    }[];
  };
}
