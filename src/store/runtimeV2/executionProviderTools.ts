import {
  RUNTIME_V2_SUBAGENT_ACCESS_MODES,
  RUNTIME_V2_SUBAGENT_TASK_KINDS,
  type ToolDefinition,
} from "../../lib/toolSchemas";
import { isWorkspaceMutationToolName } from "../../lib/workspaceMutationTools";
import { workspacePathsReferToSameFile } from "../../lib/workspacePaths";
import {
  RUNTIME_V2_SUBAGENT_MIN_START_REMAINING_MS,
  type RuntimeV2Command,
} from "../../lib/runtime-v2";
import {
  RUNTIME_V2_ATTACHMENT_READ_TOOL_NAMES,
  RUNTIME_V2_WORKSPACE_NETWORK_READ_TOOL_NAMES,
  RUNTIME_V2_WORKSPACE_SOURCE_TOOL_NAMES,
} from "../../lib/runtime-v2/workspaceReadPolicy";
import { aggregateForCurrentTurn } from "./executionAggregate";
import {
  RECORD_RUNTIME_V2_EXECUTION_CONTRACT_TOOL_NAME,
  deriveRuntimeV2ExecutionContract,
  deriveRuntimeV2ExecutionContractRepair,
  runtimeV2ExecutionContractMutationTargets,
  runtimeV2ExecutionContractReadWindow,
  runtimeV2ExecutionContractRequired,
  type RuntimeV2ExecutionContract,
} from "./executionContract";
import { deriveRuntimeV2ExecutionContractAdvance } from "./executionContractAdvance";
import {
  deriveRuntimeV2ValidationCorrectionWindow,
} from "./executionValidationCorrection";
import type {
  RuntimeV2ExecutionPortsInput,
  RuntimeV2ProviderActionWindow,
} from "./executionTypes";

const VALIDATION_TOOL_NAMES = new Set([
  "run_command",
  "browser_evaluate",
]);

export function runtimeV2SubagentStartHasRunway(input: {
  readonly now: number;
  readonly lifecycleDeadlineAt?: number;
}): boolean {
  const deadlineAt = input.lifecycleDeadlineAt;
  return deadlineAt === undefined ||
    !Number.isFinite(deadlineAt) ||
    deadlineAt - input.now >= RUNTIME_V2_SUBAGENT_MIN_START_REMAINING_MS;
}

function collaborationToolNames(input: {
  readonly ports: RuntimeV2ExecutionPortsInput;
  readonly command: RuntimeV2Command;
}): ReadonlySet<string> {
  const names = new Set<string>();
  if (input.command.payload.collaborationAllowed === false) return names;
  const active = Array.isArray(input.command.payload.activeSubagents)
    ? input.command.payload.activeSubagents
    : [];
  const remainingCapacity = Math.max(
    0,
    Number(input.command.payload.remainingSubagentCapacity) || 0,
  );
  if (
    remainingCapacity > 0 &&
    runtimeV2SubagentStartHasRunway({
      now: input.ports.now(),
      lifecycleDeadlineAt: input.ports.lifecycleDeadlineAt,
    })
  ) {
    names.add("spawn_subagent");
  }
  if (active.length > 0) names.add("wait_subagents");
  return names;
}

function runtimeV2ToolDefinition(
  definition: ToolDefinition,
  mode: string,
  actionWindow?: RuntimeV2ProviderActionWindow | null,
  correctiveSourceTargets: readonly string[] = [],
  correctiveSourceHints: readonly {
    readonly target: string;
    readonly line: number;
    readonly startLine: number;
    readonly endLine: number;
  }[] = [],
  correctiveValidationCommand = "",
  executionContract: RuntimeV2ExecutionContract | null = null,
  executionContractRequired = false,
  acceptanceEvidenceRequirements: readonly string[] = [],
): ToolDefinition {
  if (
    definition.function.name === "read_file" &&
    actionWindow === "corrective_source"
  ) {
    const properties = definition.function.parameters.properties;
    const focusedHints = correctiveSourceHints.filter((hint) =>
      correctiveSourceTargets.some((target) =>
        workspacePathsReferToSameFile(hint.target, target)
      )
    );
    const exactRanges = focusedHints.map((hint) =>
      `${hint.target}:${hint.startLine}-${hint.endLine}`
    );
    return {
      ...definition,
      function: {
        ...definition.function,
        description: [
          "Use the single fresh source-recovery batch for only the exact target named by the latest rejected mutation.",
          exactRanges.length > 0
            ? `The failed acceptance receipt already identified the causal line; read one of these exact focused ranges: ${exactRanges.join(", ")}.`
            : "Read the smallest focused range needed for a materially different editor; do not page or request the whole file.",
          "After this successful batch Runtime closes reading and requires a new exact mutation.",
        ].join(" "),
        parameters: {
          ...definition.function.parameters,
          properties: {
            ...properties,
            path: {
              ...properties.path,
              enum: [...correctiveSourceTargets],
              description:
                `Exact corrective target: ${correctiveSourceTargets.join(", ")}.`,
            },
            ...(focusedHints.length > 0
              ? {
                  start_line: {
                    ...properties.start_line,
                    description:
                      `Required focused start line from the failed acceptance receipt: ${[...new Set(focusedHints.map((hint) => hint.startLine))].join(", ")}.`,
                  },
                  end_line: {
                    ...properties.end_line,
                    description:
                      `Required focused end line from the failed acceptance receipt: ${[...new Set(focusedHints.map((hint) => hint.endLine))].join(", ")}.`,
                  },
                }
              : {}),
          },
          required: focusedHints.length > 0
            ? [...new Set([
                ...definition.function.parameters.required,
                "start_line",
                "end_line",
              ])]
            : definition.function.parameters.required,
        },
      },
    };
  }
  if (
    definition.function.name === "run_command" &&
    mode === "validate"
  ) {
    const exactValidationCommand = correctiveValidationCommand;
    const properties = definition.function.parameters.properties;
    return {
      ...definition,
      function: {
        ...definition.function,
        description: [
          "Run exactly one bounded acceptance command and wait for its exit status.",
          "The workspace root is already the execution directory; use cwd for a relative subdirectory and never prepend cd.",
          "Use build, test, lint, typecheck, check, or a bounded inline assertion.",
          exactValidationCommand
            ? `Use exactly the finite command sealed by the current validation authority: ${JSON.stringify(exactValidationCommand)}, with no redirection, pipe, tail, semicolon, echo, or wrapper.`
            : "Do not append redirection, a pipe, tail, semicolon, echo, or an exit-code wrapper.",
          "grep/find/cat/sed and other source inspection commands are not validation and will be rejected; use the dedicated read/search tools while they are advertised.",
        ].join(" "),
        parameters: exactValidationCommand
          ? {
              ...definition.function.parameters,
              properties: {
                ...properties,
                command: {
                  ...properties.command,
                    enum: [exactValidationCommand],
                    description:
                    `Exact sealed finite validation command: ${exactValidationCommand}`,
                },
              },
            }
          : definition.function.parameters,
      },
    };
  }
  if (
    definition.function.name ===
      RECORD_RUNTIME_V2_EXECUTION_CONTRACT_TOOL_NAME
  ) {
    const requiresInteraction =
      acceptanceEvidenceRequirements.includes("interaction");
    const requiresBehavioral = requiresInteraction ||
      acceptanceEvidenceRequirements.includes("behavioral");
    const parameters = definition.function.parameters;
    const behavioralValidation =
      parameters.properties.behavioral_validation;
    const interactionBranch = behavioralValidation?.anyOf?.find((branch) =>
      branch.properties?.kind?.enum?.some((kind) =>
        kind === "browser" || kind === "desktop"
      )
    );
    return {
      ...definition,
      function: {
        ...definition.function,
        description: [
          definition.function.description,
          executionContractRequired
            ? "This action is required now because the parent has materialized multiple exact source owners before its first workspace mutation. Mutation and validation tools reopen after the contract is recorded."
            : executionContract
              ? `Revision ${executionContract.revision} is active. Revise only when new source or failed-validation evidence changes the proved solution; revision_reason is required.`
              : "",
          requiresInteraction
            ? "The admitted objective requires behavioral_validation with kind browser or desktop; a static command cannot satisfy this schema."
            : requiresBehavioral
              ? "The admitted objective requires behavioral_validation containing a finite test/inline assertion or a browser/desktop observation; build, lint, and typecheck alone are invalid."
              : "",
        ].filter(Boolean).join(" "),
        parameters: requiresBehavioral && behavioralValidation
          ? {
              ...parameters,
              properties: {
                ...parameters.properties,
                behavioral_validation: requiresInteraction &&
                    interactionBranch
                  ? {
                      ...behavioralValidation,
                      anyOf: [interactionBranch],
                      description:
                        "Required interaction acceptance: choose browser or desktop and name the observable post-action result.",
                    }
                  : {
                      ...behavioralValidation,
                      description:
                        "Required behavioral acceptance: provide a finite test/inline assertion or a browser/desktop observation. Build, lint, and typecheck alone are invalid.",
                    },
              },
              required: [...new Set([
                ...parameters.required,
                "behavioral_validation",
              ])],
            }
          : parameters,
      },
    };
  }
  if (
    isWorkspaceMutationToolName(definition.function.name) &&
    executionContract
  ) {
    const targets = runtimeV2ExecutionContractMutationTargets(
      executionContract,
    );
    const properties = definition.function.parameters.properties;
    const path = properties.path;
    return {
      ...definition,
      function: {
        ...definition.function,
        description: [
          definition.function.description,
          `The active execution contract limits all mutations to: ${targets.join(", ")}.`,
        ].join(" "),
        ...(path && targets.length > 0
          ? {
              parameters: {
                ...definition.function.parameters,
                properties: {
                  ...properties,
                  path: {
                    ...path,
                    enum: targets,
                    description:
                      `Exact contract mutation target: ${targets.join(", ")}.`,
                  },
                },
              },
            }
          : {}),
      },
    };
  }
  if (definition.function.name !== "spawn_subagent") return definition;
  const properties = definition.function.parameters.properties;
  return {
    ...definition,
    function: {
      ...definition.function,
      description:
        "Delegate one independent task that can overlap real parent work. Investigation jobs are read-only. Use implement/write only after deriving a concrete solution, with exclusive narrow paths and an explicit implementation plan; Runtime stages and commits one child transaction at join.",
      parameters: {
        ...definition.function.parameters,
        properties: {
          ...properties,
          task_kind: {
            ...properties.task_kind,
            enum: executionContractRequired
              ? ["explore", "review", "validate"]
              : [...RUNTIME_V2_SUBAGENT_TASK_KINDS],
            description:
              executionContractRequired
                ? "The parent implementation contract is not recorded yet, so only read-only explore/review/validate work may be delegated."
                : "Task kind. explore/review/validate are read-only; implement is a planned scoped mutation.",
          },
          access_mode: {
            ...properties.access_mode,
            enum: executionContractRequired
              ? ["read"]
              : [...RUNTIME_V2_SUBAGENT_ACCESS_MODES],
            description:
              "Use read for investigations and write only with task_kind=implement.",
          },
          required_paths: {
            ...properties.required_paths,
            description:
              "Required narrow workspace-relative scope. Implement jobs must list every exact mutation target; targets must not overlap another active writer.",
          },
        },
        required: ["objective", "required_paths"],
      },
    },
  };
}

function runtimeV2PostMutationReviewDefinition(
  definition: ToolDefinition,
  targets: readonly string[],
): ToolDefinition {
  if (definition.function.name !== "read_file" || targets.length === 0) {
    return definition;
  }
  const properties = definition.function.parameters.properties;
  return {
    ...definition,
    function: {
      ...definition.function,
      description: [
        "Use the one bounded post-mutation self-review batch for an exact range in a target changed by the newest committed edit.",
        "This is not a repository discovery window. Read every independently needed changed-target range in this response; after the batch, continue with a contracted mutation or finite validation.",
      ].join(" "),
      parameters: {
        ...definition.function.parameters,
        properties: {
          ...properties,
          path: {
            ...properties.path,
            enum: [...targets],
            description:
              `Just-mutated review target: ${targets.join(", ")}.`,
          },
        },
      },
    },
  };
}

/**
 * Keep safe inspection available throughout Execute while making validation
 * debt executable rather than advisory. Validate also retains mutation tools:
 * a real multi-file repair may need several source-backed commits before the
 * model is ready to check the integrated result. A selected mutation moves the
 * reducer back to Acting and validation debt follows the newest commit; only a
 * finite receipt after that newest commit can satisfy acceptance.
 */
export function selectRuntimeV2ProviderToolDefinitions(input: {
  readonly ports: RuntimeV2ExecutionPortsInput;
  readonly command: RuntimeV2Command;
  readonly available: readonly ToolDefinition[];
  readonly actionWindow?: RuntimeV2ProviderActionWindow | null;
  readonly correctiveSourceTargets?: readonly string[];
  readonly correctiveValidationCommand?: string;
}): ToolDefinition[] {
  const mode = String(input.command.payload.mode || "").trim();
  const collaboration = collaborationToolNames(input);
  const aggregate = typeof input.ports.get === "function"
    ? aggregateForCurrentTurn(input.ports)
    : null;
  const directExecute = aggregate?.strategy === "execute";
  const executionContract = directExecute
    ? deriveRuntimeV2ExecutionContract(aggregate)
    : null;
  const executionContractRequired = directExecute &&
    runtimeV2ExecutionContractRequired(aggregate);
  const executionContractReadWindow =
    runtimeV2ExecutionContractReadWindow(aggregate);
  const executionContractAdvance =
    deriveRuntimeV2ExecutionContractAdvance(aggregate);
  const executionContractRepair =
    deriveRuntimeV2ExecutionContractRepair(aggregate);
  const validationCorrection =
    deriveRuntimeV2ValidationCorrectionWindow(aggregate);
  // A real failed acceptance receipt is newer evidence than the model's
  // pre-edit implementation outline. Keeping the old contract enum on editor
  // schemas here can make the diagnosed owner impossible to change, so the
  // correction window relies on ordinary source leases and user authority.
  const mutationScopeContract = validationCorrection.active
    ? null
    : executionContract;
  const adapt = (definition: ToolDefinition) =>
    runtimeV2ToolDefinition(
      definition,
      mode,
      input.actionWindow,
      input.correctiveSourceTargets,
      validationCorrection.diagnosticSourceHints,
      input.correctiveValidationCommand,
      mutationScopeContract,
      executionContractRequired,
      aggregate?.objective?.acceptanceEvidenceRequirements || [],
    );
  if (mode === "conclude") {
    return input.available.filter((definition) =>
      definition.function.name === "wait_subagents" &&
      collaboration.has("wait_subagents")
    ).map(adapt);
  }
  if (mode === "analyze") {
    if (!String(input.ports.context.runWorkspace || "").trim()) {
      return input.available.filter((definition) =>
        RUNTIME_V2_ATTACHMENT_READ_TOOL_NAMES.has(
          definition.function.name,
        )
      ).map(adapt);
    }
    return input.available.filter((definition) => {
      const name = definition.function.name;
      return RUNTIME_V2_WORKSPACE_SOURCE_TOOL_NAMES.has(name) ||
        RUNTIME_V2_WORKSPACE_NETWORK_READ_TOOL_NAMES.has(name) ||
        collaboration.has(name);
    }).map(adapt);
  }
  if (
    (mode === "execute" || mode === "validate") &&
    input.actionWindow === "validation_handoff"
  ) {
    if (input.correctiveValidationCommand) {
      return input.available.filter((definition) =>
        definition.function.name === "run_command"
      ).map(adapt);
    }
    return input.available.filter((definition) =>
      VALIDATION_TOOL_NAMES.has(definition.function.name)
    ).map(adapt);
  }
  if (
    (mode === "execute" || mode === "validate") &&
    input.actionWindow === "corrective_source"
  ) {
    return input.available.filter((definition) =>
      definition.function.name === "read_file"
    ).map(adapt);
  }
  if (
    (mode === "execute" || mode === "validate") &&
    input.actionWindow === "corrective_mutation"
  ) {
    return input.available.filter((definition) =>
      isWorkspaceMutationToolName(definition.function.name)
    ).map(adapt);
  }
  if (
    mode === "execute" &&
    executionContractRequired &&
    !executionContractRepair
  ) {
    return input.available.filter((definition) => {
      const name = definition.function.name;
      if (name === RECORD_RUNTIME_V2_EXECUTION_CONTRACT_TOOL_NAME) return true;
      if (executionContractReadWindow.closed) {
        return name === "wait_subagents" &&
          collaboration.has("wait_subagents");
      }
      return (
        RUNTIME_V2_WORKSPACE_SOURCE_TOOL_NAMES.has(name) ||
        RUNTIME_V2_WORKSPACE_NETWORK_READ_TOOL_NAMES.has(name) ||
        collaboration.has(name)
      );
    }).map(adapt);
  }
  if (
    (mode === "execute" || mode === "validate") &&
    executionContractRepair
  ) {
    return input.available.filter((definition) =>
      definition.function.name ===
      RECORD_RUNTIME_V2_EXECUTION_CONTRACT_TOOL_NAME
    ).map(adapt);
  }
  if (
    (mode === "execute" || mode === "validate") &&
    executionContractAdvance.required &&
    executionContractAdvance.pendingTargets.length > 0
  ) {
    // A recovery response cannot skip a still-pending implementation step.
    // Previously closed_recovery could expose only run_command here, while
    // authorization correctly rejected that same command as premature. Keep
    // the advertised surface and the hard contract boundary consistent.
    return input.available.filter((definition) => {
      const name = definition.function.name;
      return name === RECORD_RUNTIME_V2_EXECUTION_CONTRACT_TOOL_NAME ||
        isWorkspaceMutationToolName(name) ||
        (name === "wait_subagents" && collaboration.has(name));
    }).map(adapt);
  }
  if (
    (mode === "execute" || mode === "validate") &&
    input.actionWindow === "closed_recovery"
  ) {
    if (input.correctiveValidationCommand) {
      return input.available.filter((definition) =>
        definition.function.name === "run_command"
      ).map(adapt);
    }
    return input.available.filter((definition) =>
      isWorkspaceMutationToolName(definition.function.name)
    ).map(adapt);
  }
  if (
    (mode === "execute" || mode === "validate") &&
    validationCorrection.active
  ) {
    if (validationCorrection.validationCommandUnavailable) {
      if (validationCorrection.repeatedFailedValidations >= 1) {
        // One materially different finite validator has also failed without a
        // source diagnostic. Preserve the edits and let the normal terminal
        // handoff report incomplete validation instead of cycling commands.
        return [];
      }
      return input.available.filter((definition) =>
        VALIDATION_TOOL_NAMES.has(definition.function.name)
      ).map(adapt);
    }
    // A failed acceptance receipt returns to the ordinary inspect/edit
    // surface. Do not layer a second exact-read state machine over source
    // visibility and mutation preflight: that creates contradictory states in
    // which the only advertised read is simultaneously forbidden. Validation
    // remains withheld until a real mutation establishes a new boundary.
    return input.available.filter((definition) => {
      const name = definition.function.name;
      return RUNTIME_V2_WORKSPACE_SOURCE_TOOL_NAMES.has(name) ||
        isWorkspaceMutationToolName(name) ||
        collaboration.has(name);
    }).map(adapt);
  }
  if (
    (mode === "execute" || mode === "validate") &&
    executionContractAdvance.required
  ) {
    if (
      !executionContractAdvance.sourceReviewAvailable
    ) {
      if (input.correctiveValidationCommand) {
        return input.available.filter((definition) =>
          definition.function.name === "run_command"
        ).map(adapt);
      }
      return input.available.filter((definition) =>
        VALIDATION_TOOL_NAMES.has(definition.function.name)
      ).map(adapt);
    }
    return input.available.filter((definition) => {
      const name = definition.function.name;
      return name === RECORD_RUNTIME_V2_EXECUTION_CONTRACT_TOOL_NAME ||
        isWorkspaceMutationToolName(name) ||
        VALIDATION_TOOL_NAMES.has(name) ||
        (name === "read_file" &&
          executionContractAdvance.sourceReviewAvailable) ||
        (name === "wait_subagents" && collaboration.has(name));
    }).map((definition) =>
      runtimeV2PostMutationReviewDefinition(
        adapt(definition),
        executionContractAdvance.sourceReviewTargets,
      )
    );
  }
  if (mode === "validate") {
    return input.available.filter((definition) => {
      const name = definition.function.name;
      if (VALIDATION_TOOL_NAMES.has(name)) {
        return true;
      }
      if (isWorkspaceMutationToolName(name)) {
        return true;
      }
      if (
        directExecute &&
        name === RECORD_RUNTIME_V2_EXECUTION_CONTRACT_TOOL_NAME
      ) {
        return true;
      }
      return !input.actionWindow && (
        RUNTIME_V2_WORKSPACE_SOURCE_TOOL_NAMES.has(name) ||
        RUNTIME_V2_WORKSPACE_NETWORK_READ_TOOL_NAMES.has(name) ||
        collaboration.has(name)
      );
    }).map(adapt);
  }
  return input.available.filter((definition) => {
    const name = definition.function.name;
    return RUNTIME_V2_WORKSPACE_SOURCE_TOOL_NAMES.has(name) ||
      RUNTIME_V2_WORKSPACE_NETWORK_READ_TOOL_NAMES.has(name) ||
      isWorkspaceMutationToolName(name) ||
      VALIDATION_TOOL_NAMES.has(name) ||
      (directExecute &&
        name === RECORD_RUNTIME_V2_EXECUTION_CONTRACT_TOOL_NAME) ||
      collaboration.has(name);
  }).map(adapt);
}

/**
 * Tool order is request guidance, never authorization. Once the exact current
 * source is materialized and the durable ledger shows only source progress,
 * put existing mutation capabilities first while preserving the complete
 * inspect-edit-verify surface and each group's original order.
 */
export function prioritizeRuntimeV2ProviderToolDefinitions(input: {
  readonly command: RuntimeV2Command;
  readonly tools: readonly ToolDefinition[];
  readonly hasMaterializedSourceEvidence: boolean;
}): ToolDefinition[] {
  const pressure =
    input.command.payload.effectPressure &&
      typeof input.command.payload.effectPressure === "object" &&
      !Array.isArray(input.command.payload.effectPressure)
      ? input.command.payload.effectPressure as Record<string, unknown>
      : null;
  const shouldPrioritizeMutation =
    String(input.command.payload.mode || "") === "execute" &&
    input.hasMaterializedSourceEvidence &&
    pressure?.reason === "source_only_frontier";
  if (!shouldPrioritizeMutation) return [...input.tools];

  const contractOnly = input.tools.some((tool) =>
    tool.function.name === RECORD_RUNTIME_V2_EXECUTION_CONTRACT_TOOL_NAME
  ) && !input.tools.some((tool) =>
    isWorkspaceMutationToolName(tool.function.name)
  );

  const mutationRank = (toolName: string): number => {
    if (
      contractOnly &&
      toolName === RECORD_RUNTIME_V2_EXECUTION_CONTRACT_TOOL_NAME
    ) return 0;
    if (toolName === "replace_in_file") return 1;
    if (toolName === "apply_patch") return 2;
    if (toolName === "write_file") return 3;
    return isWorkspaceMutationToolName(toolName) ? 4 : 5;
  };
  return input.tools
    .map((tool, index) => ({ tool, index }))
    .sort((left, right) => {
      const leftRank = mutationRank(left.tool.function.name);
      const rightRank = mutationRank(right.tool.function.name);
      return leftRank - rightRank || left.index - right.index;
    })
    .map(({ tool }) => tool);
}

export {
  buildRuntimeV2TextEnvelopeCatalog,
  normalizeRuntimeV2ProviderToolCalls,
  runtimeV2ProviderToolArgumentViolation,
} from "./executionProviderToolSchema";
