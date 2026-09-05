import type { ResolvedRunIntent } from "../../lib/runIntent";
import type { SkillCatalogSnapshot } from "../../lib/agentSkills";
import type { RuntimeContextBudget } from "../../lib/runtimeContextBudget";
import type { ProjectBaselineContext } from "../../lib/projectBaseline";
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
  readonly networkRead?: import("../../lib/networkRead").NetworkReadPolicy;
  readonly turnId: string;
  readonly uiDisplayTurnId: string;
  readonly runWorkspace: string | undefined;
  readonly runSessionKey: string;
  readonly runSessionId: number | null | undefined;
  readonly runScopeKey: string;
  readonly phaseLanguage: "zh" | "en";
  readonly effectiveRunIntent: ResolvedRunIntent;
  readonly runtimeRunIntent: ResolvedRunIntent;
  /** Exact live project rules captured at the Turn safe boundary. */
  readonly workspaceInstructionContext?: string;
  /** Frozen, deterministic workspace facts. This is not an instruction,
   * capability, validation receipt, or persisted Session truth. */
  readonly projectBaselineContext?: ProjectBaselineContext | null;
  /** Immutable catalog revision shared by parent, Plan, Goal slices and safe
   * tool execution for this Run. */
  readonly skillCatalog?: SkillCatalogSnapshot | null;
  readonly goalCreationAuthorization?: GoalCreationAuthorization | null;
  readonly goalContinuationAuthorization?: GoalContinuationAuthorization | null;
  readonly abortCtrl: AbortController;
  readonly timerInterval: unknown;
  readonly harnessRunId: string;
  readonly turnInputContextSignals: TurnInputContextSignals;
  /**
   * One immutable budget resolved at Run admission. Every provider request,
   * history compactor, and bounded read in this Run consumes this same value.
   */
  readonly runtimeContextBudget?: RuntimeContextBudget | null;
  /** Optional parent-owned objective slice. Goal execution must preserve the
   * original criterion ids instead of re-admitting a synthesized prompt as
   * an anonymous Execute request. */
  readonly executeAdmission?: {
    readonly objective: string;
    readonly constraints?: readonly string[];
    readonly acceptanceCriteria: readonly {
      readonly id: string;
      readonly text: string;
      readonly evidenceRequirement?:
        | "static"
        | "behavioral"
        | "interaction";
    }[];
  };
}

export interface RuntimeV2ObjectiveAdmission {
  readonly objective: string;
  readonly constraints: readonly string[];
  readonly acceptanceCriteria: readonly {
    readonly id: string;
    readonly text: string;
    readonly evidenceRequirement?: "static" | "behavioral" | "interaction";
  }[];
}

/**
 * Preserve an upstream Goal admission when present. An ordinary raw Turn has
 * no trusted semantic classifier, so Runtime binds the exact user request as
 * one opaque criterion instead of guessing requirements from prose.
 */
export function resolveRuntimeV2ObjectiveAdmission(
  context: RuntimeV2SubmissionContext,
  fallbackObjective: string,
): RuntimeV2ObjectiveAdmission {
  const supplied = context.executeAdmission;
  if (supplied?.acceptanceCriteria.length) {
    return {
      objective: String(supplied.objective || fallbackObjective).trim(),
      constraints: [...(supplied.constraints || [])],
      acceptanceCriteria: supplied.acceptanceCriteria.map((criterion) => ({
        ...criterion,
      })),
    };
  }
  const objective = String(fallbackObjective || "").trim();
  return {
    objective,
    constraints: [],
    acceptanceCriteria: [{
      id: "criterion-user-objective",
      text: objective,
    }],
  };
}

export function withRuntimeV2ContextBudget<
  T extends RuntimeV2SubmissionContext,
>(
  context: T,
  runtimeContextBudget: RuntimeContextBudget | null,
): T & { readonly runtimeContextBudget: RuntimeContextBudget | null } {
  return {
    ...context,
    runtimeContextBudget,
  };
}
