import { explicitShellCommandFromRequest, isEditorDiagnosticRepairRequest, looksLikeExplicitWorkspaceMutationRequest, type CommandDirective, type ResolvedRunIntent, type SemanticTaskIntent } from "../../lib/runIntent";
import type { RuntimeV2CompletionRequirement } from "../../lib/runtime-v2/contracts";
import { requestedRuntimeV2NetworkRead } from "../../lib/runtime-v2/completionRequirement";
import { normalizeTurnApprovalCapabilities, normalizeTurnCapabilityRestrictions, type TurnCapability } from "../../lib/turnCapabilities";
import type { SkillCatalogSnapshot } from "../../lib/agentSkills";
import type { RuntimeContextBudget } from "../../lib/runtimeContextBudget";
import type { ProjectBaselineContext } from "../../lib/projectBaseline";
import type { TurnInputContextSignals } from "../../lib/turnIntake";
import type {
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
  readonly knowledgeContext?: import("../../lib/knowledgeReferences").KnowledgeContextPacket;
  readonly planPurpose?: "plan" | "rules";
  readonly sourcePlanDraft?: import("../../lib/planDrafts").PlanDraftRecord;
  readonly approvedPlanContinuation?: import("../../lib/runtime-v2/contracts").ApprovedWorkPlanContinuationReference;
  readonly turnId: string;
  readonly uiDisplayTurnId: string;
  readonly runWorkspace: string | undefined;
  readonly runSessionKey: string;
  /** Canonical Session owner frozen from the accepted admission. */
  readonly runSessionEpoch?: string;
  readonly runSessionId: number | null | undefined;
  readonly runScopeKey: string;
  readonly phaseLanguage: "zh" | "en";
  readonly effectiveRunIntent: ResolvedRunIntent;
  readonly runtimeRunIntent: ResolvedRunIntent;
  readonly requiredCapabilities?: readonly TurnCapability[];
  readonly semanticWorkType?: SemanticTaskIntent["workType"];
  readonly effectiveCommandDirective?: CommandDirective | null;
  readonly intentClarification?: import("../../lib/turnClarification").TurnClarification;
  readonly capabilityRestrictions?: readonly TurnCapability[];
  readonly approvalRequiredCapabilities?: readonly TurnCapability[];
  /** Exact live project rules captured at the Turn safe boundary. */
  readonly workspaceInstructionContext?: string;
  /** Frozen, deterministic workspace facts. This is not an instruction,
   * capability, validation receipt, or persisted Session truth. */
  readonly projectBaselineContext?: ProjectBaselineContext | null;
  /** Immutable catalog revision shared by parent, Plan and safe
   * tool execution for this Run. */
  readonly skillCatalog?: SkillCatalogSnapshot | null;
  /** Connector view resolved for this Run's workspace before execution. */
  readonly workspaceMcpSnapshot?: import("../../lib/workspaceMcp").WorkspaceMcpSnapshot | null;


  readonly abortCtrl: AbortController;
  readonly timerInterval: unknown;
  readonly harnessRunId: string;
  readonly turnInputContextSignals: TurnInputContextSignals;
  /**
   * One immutable budget resolved at Run admission. Every provider request,
   * history compactor, and bounded read in this Run consumes this same value.
   */
  readonly runtimeContextBudget?: RuntimeContextBudget | null;
  /** Optional parent-owned objective slice. Preserve its original criterion
   * ids instead of re-admitting a synthesized prompt as a new objective. */
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
  readonly completionRequirement?: RuntimeV2CompletionRequirement;
  readonly capabilityRestrictions?: readonly TurnCapability[];
  readonly approvalRequiredCapabilities?: readonly TurnCapability[];
  readonly constraints: readonly string[];
  readonly acceptanceCriteria: readonly {
    readonly id: string;
    readonly text: string;
    readonly evidenceRequirement?: "static" | "behavioral" | "interaction";
  }[];
}

function executeCompletionRequirement(context: RuntimeV2SubmissionContext, request: string): RuntimeV2CompletionRequirement | undefined {
  if (context.runtimeRunIntent !== "execute") return;
  const directive = context.effectiveCommandDirective;
  const required = context.requiredCapabilities || [];
  const editorDiagnostics = isEditorDiagnosticRepairRequest(request);
  if (editorDiagnostics || context.semanticWorkType === "implement" || required.includes("workspace_write") ||
      directive?.kind === "file_modify" || (!context.semanticWorkType && looksLikeExplicitWorkspaceMutationRequest(request))) {
    return { kind: "workspace_change", ...(editorDiagnostics ? { editorDiagnostics: true } : {}) };
  }
  const exactCommand = explicitShellCommandFromRequest(request) || directive?.exactCommand;
  if (exactCommand) return { kind: "requested_operation", channel: "command", exactCommand };
  if (directive?.kind === "git" && directive.action && directive.action !== "git") {
    return { kind: "requested_operation", channel: "command", action: `git:${directive.action}` };
  }
  if (directive?.kind === "shell" && ["test", "build", "start"].includes(directive.action || "")) {
    return { kind: "requested_operation", channel: "command",
      ...(directive.action ? { action: directive.action } : {}) };
  }
  if (directive?.kind === "unity" && directive.action === "editor_execute") {
    return { kind: "requested_operation", channel: "external", toolName: "execute_code", action: "execute" };
  }
  if (directive?.kind === "mcp" && directive.target && directive.target !== "mcp") {
    return { kind: "requested_operation", channel: "external", toolName: directive.target,
      ...(directive.action && !["tool_route", "mcp_context"].includes(directive.action) ? { action: directive.action } : {}) };
  }
  return requestedRuntimeV2NetworkRead(request, required.includes("network")) || { kind: "unspecified" };
}

/**
 * Preserve an upstream structured admission when present. Task routing does not
 * classify acceptance evidence, so an ordinary Turn binds the exact user
 * request as one opaque criterion instead of guessing requirements from prose.
 */
export function resolveRuntimeV2ObjectiveAdmission(
  context: RuntimeV2SubmissionContext,
  fallbackObjective: string,
): RuntimeV2ObjectiveAdmission {
  const supplied = context.executeAdmission;
  const completionRequirement = executeCompletionRequirement(context, fallbackObjective);
  const restrictions = context.capabilityRestrictions === undefined ? {} : {
    capabilityRestrictions: normalizeTurnCapabilityRestrictions(context.capabilityRestrictions),
  };
  const review = context.approvalRequiredCapabilities === undefined ? {} : {
    approvalRequiredCapabilities: normalizeTurnApprovalCapabilities(context.approvalRequiredCapabilities),
  };
  if (supplied?.acceptanceCriteria.length) {
    return {
      objective: String(supplied.objective || fallbackObjective).trim(),
      ...(completionRequirement ? { completionRequirement } : {}),
      ...restrictions,
      ...review,
      constraints: [...(supplied.constraints || [])],
      acceptanceCriteria: supplied.acceptanceCriteria.map((criterion) => ({
        ...criterion,
      })),
    };
  }
  const objective = String(fallbackObjective || "").trim();
  return {
    objective,
    ...(completionRequirement ? { completionRequirement } : {}),
    ...restrictions,
    ...review,
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
