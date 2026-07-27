import type { AgentMessage } from "../../lib/agentMessages";
import { TOOL_DEFINITIONS, type ToolDefinition } from "../../lib/toolSchemas";
import { workspacePathsReferToSameFile } from "../../lib/workspacePaths";
import {
  WORK_PLAN_V1_SCHEMA_VERSION,
  type WorkPlanDraftV1,
  type WorkPlanRuntimeEvidence,
} from "../../lib/runtime-v2";
import type { ConversationTurn } from "../../lib/workflowModels";
import type { RuntimeV2SubmissionContext } from "./submissionContext";

export const SUBMIT_WORK_PLAN_TOOL_NAME = "submit_runtime_v2_work_plan";
export const PLAN_MODEL_COMPACTION_INTERVAL = 10;
export const PLAN_MODEL_DEADLINE_MS = 8 * 60_000;
export const PLAN_MODEL_REQUEST_TIMEOUT_MS = 90_000;
export const PLAN_SYNTHESIS_REQUEST_TIMEOUT_MS = 3 * 60_000;
export const PLAN_DISCOVERY_DEADLINE_MS = 3 * 60_000;
export const PLAN_DISCOVERY_ACTION_BUDGET = 8;
export const PLAN_AUDIT_DISCOVERY_DEADLINE_MS = 2 * 60_000;
export const PLAN_AUDIT_ACTION_BUDGET = 3;
export const PLAN_CONTEXT_RESULT_CHARS = 10_000;
export const PLAN_SYNTHESIS_RECOVERY_REQUEST_TIMEOUT_MS = 90_000;
export const PLAN_SYNTHESIS_RECOVERY_MAX_TOKENS = 4_096;

const PLAN_SYNTHESIS_EVIDENCE_CHARS = 36_000;
const PLAN_SYNTHESIS_RECOVERY_EVIDENCE_CHARS = 18_000;

export const PLAN_READ_ONLY_TOOL_NAMES = new Set([
  "list_directory",
  "glob_search",
  "grep_search",
  "repo_map_search",
  "repo_map_context",
  "code_ast_query",
  "find_symbol_references",
  "read_file",
  "get_file_outline",
  "git_status",
  "git_diff",
  "get_project_skeleton",
]);

export const SUBMIT_WORK_PLAN_TOOL: ToolDefinition = {
  type: "function",
  function: {
    name: SUBMIT_WORK_PLAN_TOOL_NAME,
    description: "Submit an evidence-grounded plan for review. The narrative is open Markdown; only concrete changes and validations are structurally required. This does not modify project files.",
    parameters: {
      type: "object",
      properties: {
        planMarkdown: {
          type: "string",
          description: "Free task-specific Markdown for the diagnosis, approach, decisions, or caveats that add value. State proved causes rather than guesses. Do not repeat the changes or validation lists; the runtime renders those.",
        },
        changes: {
          type: "array",
          minItems: 1,
          items: {
            type: "object",
            properties: {
              title: { type: "string" },
              operation: {
                type: "string",
                enum: ["modify", "create", "delete", "preserve"],
              },
              targets: {
                type: "array",
                minItems: 1,
                items: { type: "string" },
              },
              change: {
                type: "string",
                description: "The exact code, contract, or behavior change. Include relevant symbols and preserved boundaries.",
              },
              expectedOutcome: { type: "string" },
            },
            required: ["targets", "change"],
          },
        },
        validations: {
          type: "array",
          minItems: 1,
          items: {
            type: "object",
            properties: {
              kind: {
                type: "string",
                enum: ["finite_command", "browser", "desktop", "assertion", "advisory"],
              },
              command: {
                type: "string",
                description: "Only for finite_command. Use a bounded build, test, check, or lint command; never a dev server, watcher, or manual instruction.",
              },
              cwd: { type: "string" },
              expectedOutcome: {
                type: "string",
                description: "The observable pass condition. Put browser or desktop interaction details here.",
              },
              required: { type: "boolean" },
            },
            required: ["kind", "expectedOutcome"],
          },
        },
        questions: {
          type: "array",
          items: { type: "string" },
          description: "Optional decisions that genuinely require the user. Omit when evidence resolves the task.",
        },
      },
      required: ["planMarkdown", "changes", "validations"],
    },
  },
};

export const PLAN_MODEL_TOOLS = [
  ...TOOL_DEFINITIONS.filter((definition) =>
    PLAN_READ_ONLY_TOOL_NAMES.has(definition.function.name)
  ),
  SUBMIT_WORK_PLAN_TOOL,
];

export const PLAN_AUDIT_TOOLS = PLAN_MODEL_TOOLS.filter(
  (definition) => definition.function.name !== SUBMIT_WORK_PLAN_TOOL_NAME,
);

export type PlanModelStage =
  | "discovery"
  | "synthesis"
  | "audit_discovery"
  | "audit_synthesis";

export function isPlanSubmissionStage(stage: PlanModelStage): boolean {
  return stage === "synthesis" || stage === "audit_synthesis";
}

export function boundedPlanContent(
  value: unknown,
  max = PLAN_CONTEXT_RESULT_CHARS,
): string {
  const raw = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  const text = String(raw || "").trim();
  return text.length <= max
    ? text
    : `${text.slice(0, Math.max(0, max - 48))}\n[Runtime v2 truncated this read result.]`;
}

export function providerPlanMessages(input: {
  readonly turn: ConversationTurn;
  readonly context: RuntimeV2SubmissionContext;
  readonly overview: string;
}): AgentMessage[] {
  const language = input.context.phaseLanguage === "en" ? "English" : "简体中文";
  return [
    {
      role: "system",
      content: [
        "[MAIN RUNTIME V2 PLAN]",
        `Workspace: ${input.context.runWorkspace || "global"}`,
        `Respond in: ${language}`,
        "You are preparing a reviewable plan, not implementing it. Only the supplied read-only tools and submit_runtime_v2_work_plan are available.",
        "Base the plan on tool evidence. Do not invent source facts, edit project files, or write plan.md.",
        "Read every exact modify/delete target before submitting; the runtime binds its versioned evidence automatically.",
        "Trace the complete cause across owners before submitting. If an investigated owner must remain unchanged, say so in the narrative or add a preserve change instead of proposing an unnecessary edit.",
        "When evidence is sufficient, call submit_runtime_v2_work_plan exactly once. Write task-specific Markdown rather than filling a fixed report template.",
        "The submission only needs a concrete change list and validation list. The runtime owns evidence binding, dependencies, approval identity and rendering.",
        "Use finite_command for a bounded build/test/check command when the workspace provides one. Use browser only for web DOM behavior and desktop for native GUI behavior; put interaction details in expectedOutcome, not command.",
        "Use questions only for a real user-owned decision.",
      ].join("\n"),
    },
    { role: "user", content: input.turn.userPrompt },
    {
      role: "user",
      content: `[E1] workspace overview\n${boundedPlanContent(input.overview, 12_000)}`,
    },
  ];
}

export function boundedPlanTranscript(
  messages: readonly AgentMessage[],
): AgentMessage[] {
  if (messages.length <= 24) return [...messages];
  return [
    ...messages.slice(0, 3),
    ...messages.slice(-(24 - Math.min(3, messages.length))),
  ];
}

export function compactRetainedPlanObservation(
  value: string,
  max: number,
): string {
  if (value.length <= max) return value;
  const window = Math.max(1, Math.floor((max - 120) / 3));
  const middle = Math.max(0, Math.floor((value.length - window) / 2));
  return [
    value.slice(0, window),
    "[Runtime v2 omitted unchanged middle context.]",
    value.slice(middle, middle + window),
    "[Runtime v2 omitted unchanged middle context.]",
    value.slice(-window),
  ].join("\n");
}

function latestSubmittedPlanArguments(
  messages: readonly AgentMessage[],
  beforeIndex = messages.length,
): string {
  return messages
    .slice(0, beforeIndex)
    .reverse()
    .flatMap((message) => {
      if (message.role !== "assistant" || !Array.isArray(message.tool_calls)) {
        return [];
      }
      const call = [...message.tool_calls].reverse().find(
        (entry) => entry.function?.name === SUBMIT_WORK_PLAN_TOOL_NAME,
      );
      return call ? [String(call.function.arguments || "")] : [];
    })[0] || "";
}

function compactPlanEvidencePacket(input: {
  readonly evidence: readonly WorkPlanRuntimeEvidence[];
  readonly evidenceContents: ReadonlyMap<string, string>;
  readonly charBudget?: number;
}): string {
  const charBudget = input.charBudget || PLAN_SYNTHESIS_EVIDENCE_CHARS;
  const perEvidenceBudget = Math.max(
    input.charBudget ? 1_400 : 2_400,
    Math.min(
      8_000,
      Math.floor(charBudget / Math.max(1, input.evidence.length)),
    ),
  );
  return [
    "[Runtime v2 evidence packet]",
    ...input.evidence.map((entry) => {
      const observed = input.evidenceContents.get(entry.id) || entry.statement;
      return [
        `${entry.id} · ${entry.target} · ${entry.version || "unversioned"}`,
        compactRetainedPlanObservation(observed, perEvidenceBudget),
      ].join("\n");
    }),
  ].join("\n\n");
}

export function synthesisPlanTranscript(input: {
  readonly messages: readonly AgentMessage[];
  readonly evidence: readonly WorkPlanRuntimeEvidence[];
  readonly evidenceContents: ReadonlyMap<string, string>;
  readonly audit: boolean;
  readonly compactRecovery: boolean;
}): AgentMessage[] {
  let lastSubmissionOutcomeIndex = -1;
  for (let index = input.messages.length - 1; index >= 0; index -= 1) {
    const message = input.messages[index]!;
    if (
      message.role === "tool" &&
      /^WORK_PLAN_(?:REJECTED|DRAFT_ACCEPTED_FOR_AUDIT)\b/.test(
        String(message.content || ""),
      )
    ) {
      lastSubmissionOutcomeIndex = index;
      break;
    }
  }
  const lastSubmissionOutcome = lastSubmissionOutcomeIndex >= 0
    ? input.messages[lastSubmissionOutcomeIndex]
    : null;
  const lastRejection = lastSubmissionOutcome &&
    String(lastSubmissionOutcome.content || "").startsWith("WORK_PLAN_REJECTED:")
    ? lastSubmissionOutcome
    : null;
  const rejectedSubmission = lastRejection
    ? latestSubmittedPlanArguments(input.messages, lastSubmissionOutcomeIndex)
    : "";
  if (lastRejection && rejectedSubmission) {
    return [
      ...input.messages.slice(0, 2),
      {
        role: "system",
        content: "Correct the rejected WorkPlan structure and call submit_runtime_v2_work_plan. Do not investigate again.",
      },
      {
        role: "user",
        content: [
          `Validation feedback:\n${String(lastRejection.content || "").slice(0, 4_000)}`,
          `Rejected submission to correct:\n${rejectedSubmission.slice(0, 12_000)}`,
        ].join("\n\n"),
      },
    ];
  }
  return [
    ...input.messages.slice(0, 3),
    {
      role: "user",
      content: compactPlanEvidencePacket({
        ...input,
        ...(input.compactRecovery
          ? { charBudget: PLAN_SYNTHESIS_RECOVERY_EVIDENCE_CHARS }
          : {}),
      }),
    },
    {
      role: "system",
      content: [
        ...(input.compactRecovery
          ? [
              "The preceding synthesis request was closed at the transport deadline. This is the single bounded recovery request: use only this compact evidence packet and submit one complete plan now.",
            ]
          : []),
        input.audit
          ? [
              "This is the mandatory evidence audit. Write the final plan independently from the audited evidence; do not preserve the first draft's wording, target choices, or assumptions.",
              "For every user-reported symptom, verify an exact trigger → function or contract → state transition → visible outcome chain from the retained source.",
              "Challenge plausible but unproved explanations. Check initial placeholder state, programmatic UI updates versus user input, and serialized argument names across framework or language boundaries whenever the evidence contains them.",
              "Account for each relevant source owner with a concrete modify or preserve decision. Remove unnecessary changes, source-sized code patches, unresolved source-reading questions, dev servers, and manual instructions from command fields.",
            ].join(" ")
          : [
              "The read-only discovery window is closed. Call submit_runtime_v2_work_plan now; no other tool is available.",
              "Before submitting, reconcile the evidence into a concrete causal chain, cover every required source owner with a modify or preserve decision, and use observable bounded validation.",
              "Do not submit speculation, a dev-server command as a finite check, or manual click instructions in the command field.",
            ].join(" "),
      ].join(" "),
    },
  ];
}

export function auditDiscoveryPlanTranscript(input: {
  readonly messages: readonly AgentMessage[];
  readonly evidence: readonly WorkPlanRuntimeEvidence[];
  readonly evidenceContents: ReadonlyMap<string, string>;
}): AgentMessage[] {
  return [
    ...input.messages.slice(0, 3),
    {
      role: "user",
      content: compactPlanEvidencePacket(input),
    },
    {
      role: "system",
      content: [
        "Perform an independent evidence audit; do not rely on or repair the first draft.",
        "Use exactly one read-only action now to investigate the most consequential causal link that the current evidence does not make exact.",
        "Compare every user-reported symptom with an exact trigger → function or contract → state transition → visible outcome chain.",
        "Prioritize a missing source owner or a different source window; do not reread an unchanged observation.",
        "You cannot submit during this bounded audit-discovery pass. The runtime will request one final corrected plan after the audit reads close.",
      ].join(" "),
    },
  ];
}

export function decodeStructuredPlanArguments(
  value: unknown,
): Record<string, unknown> | null {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  try {
    const parsed = JSON.parse(String(value || ""));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

export function isPlanProviderRequestTimeout(
  error: unknown,
  requestSignal: AbortSignal,
  parentSignal: AbortSignal,
): boolean {
  if (parentSignal.aborted) return false;
  if (requestSignal.aborted) return true;
  const name = error instanceof Error ? error.name : "";
  const detail = error instanceof Error ? error.message : String(error || "");
  return name === "AbortError" ||
    /\b(?:STREAM|HTTP|PROVIDER)[A-Z0-9_ -]*TIMEOUT\b/i.test(detail) ||
    /\b(?:timed?\s*out|timeout)\b/i.test(detail);
}

function parseJsonArrayFields(
  record: Record<string, unknown>,
  fields: readonly string[],
  required = false,
): readonly unknown[] {
  const field = fields.find((candidate) => record[candidate] !== undefined);
  if (!field) {
    if (required) throw new Error(`${fields[0]} is required.`);
    return [];
  }
  const value = record[field];
  if (Array.isArray(value)) return value;
  if (typeof value !== "string") {
    throw new Error(`${field} must be a JSON array string.`);
  }
  const parsed = JSON.parse(value);
  if (!Array.isArray(parsed)) throw new Error(`${field} must decode to an array.`);
  return parsed;
}

function parseArrayFields(
  record: Record<string, unknown>,
  directFields: readonly string[],
  legacyJsonFields: readonly string[],
  required = false,
): readonly unknown[] {
  const directField = directFields.find((candidate) => record[candidate] !== undefined);
  if (directField) {
    const value = record[directField];
    if (Array.isArray(value)) return value;
    if (typeof value === "string") {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) return parsed;
    }
    throw new Error(`${directField} must be an array or JSON array string.`);
  }
  return parseJsonArrayFields(record, legacyJsonFields, required);
}

export function workPlanDraftFromSubmission(
  candidate: Record<string, unknown>,
  evidence: readonly WorkPlanRuntimeEvidence[],
  objective: string,
): { readonly draft: WorkPlanDraftV1; readonly normalized: boolean } {
  const raw = {
    schemaVersion: WORK_PLAN_V1_SCHEMA_VERSION,
    objective: String(objective || candidate.objective || ""),
    summary: String(
      candidate.planMarkdown ||
      candidate.plan ||
      candidate.summary ||
      objective ||
      "",
    ),
    findings: parseJsonArrayFields(
      candidate,
      ["findingsJson"],
    ) as WorkPlanDraftV1["findings"],
    steps: parseArrayFields(
      candidate,
      ["changes"],
      ["changesJson", "stepsJson"],
      true,
    ) as readonly Record<string, any>[],
    validations: parseArrayFields(
      candidate,
      ["validations"],
      ["validationJson", "validationsJson"],
      true,
    ) as readonly Record<string, any>[],
    risks: parseJsonArrayFields(
      candidate,
      ["risksJson"],
    ) as WorkPlanDraftV1["risks"],
    assumptions: parseJsonArrayFields(
      candidate,
      ["assumptionsJson"],
    ) as WorkPlanDraftV1["assumptions"],
    blockingQuestions: parseArrayFields(
      candidate,
      ["questions"],
      ["questionsJson", "blockingQuestionsJson"],
    ) as WorkPlanDraftV1["blockingQuestions"],
  };
  const knownEvidenceIds = new Set(evidence.map((entry) => entry.id));
  const stringList = (value: unknown): string[] =>
    Array.isArray(value)
      ? value.map((entry) => String(entry || "").trim()).filter(Boolean)
      : [];
  const knownBasis = (value: unknown): string[] => stringList(value).filter(
    (id) => knownEvidenceIds.has(id),
  );
  const steps = (Array.isArray(raw.steps) ? raw.steps : []).map((step, index) => {
    const targets = stringList(
      Array.isArray(step?.targets)
        ? step.targets
        : Array.isArray(step?.files)
          ? step.files
          : typeof step?.target === "string"
            ? [step.target]
            : [],
    );
    const targetEvidenceIds = evidence.filter((entry) =>
      entry.version &&
      targets.some((target) =>
        workspacePathsReferToSameFile(entry.target, target)
      )
    ).map((entry) => entry.id);
    const requestedOperation = String(step?.operation || "").trim();
    const operation = (
      ["modify", "create", "delete", "preserve"] as const
    ).find((candidateOperation) => candidateOperation === requestedOperation) || (
      targets.length > 0 &&
      targets.every((target) =>
        evidence.some((entry) =>
          !!entry.version && workspacePathsReferToSameFile(entry.target, target)
        )
      )
        ? "modify"
        : "create"
    );
    const change = String(
      step?.change ||
      step?.approach ||
      step?.description ||
      "",
    ).trim();
    const expectedOutcome = String(
      step?.expectedOutcome ||
      step?.outcome ||
      change,
    ).trim();
    const dependsOn = (Array.isArray(step?.dependsOn) ? step.dependsOn : [])
      .map((value: unknown) => Number(value))
      .filter((value: number) => Number.isInteger(value))
      .map((value: number) =>
        value >= index && value > 0 && value - 1 < index ? value - 1 : value
      )
      .filter((value: number) => value >= 0 && value < index);
    return {
      title: String(step?.title || change || targets[0] || `Step ${index + 1}`),
      operation,
      targets,
      basis: [...new Set([
        ...knownBasis(step?.basis),
        ...targetEvidenceIds,
      ])],
      change,
      expectedOutcome,
      dependsOn: [...new Set(dependsOn)],
    };
  }) as WorkPlanDraftV1["steps"];
  const rawValidationIndexes = (Array.isArray(raw.validations) ? raw.validations : [])
    .flatMap((validation) => Array.isArray(validation?.stepIndexes)
      ? validation.stepIndexes.map(Number).filter(Number.isInteger)
      : []);
  const oneBasedValidationIndexes =
    rawValidationIndexes.length > 0 &&
    !rawValidationIndexes.includes(0) &&
    rawValidationIndexes.some((index) => index === steps.length);
  const validations: Array<WorkPlanDraftV1["validations"][number]> = (
    Array.isArray(raw.validations) ? raw.validations : []
  ).map(
    (validation) => {
      const requestedCommand = typeof validation?.command === "string"
        ? validation.command.trim()
        : "";
      const requestedKind = String(validation?.kind || "").trim();
      const kind = (
        ["finite_command", "browser", "desktop", "assertion", "advisory"] as const
      ).find((candidateKind) => candidateKind === requestedKind) || (
        requestedCommand ? "finite_command" : "assertion"
      );
      const command = kind === "finite_command" ? requestedCommand : "";
      const suppliedStepIndexes = Array.isArray(validation?.stepIndexes)
        ? validation.stepIndexes
        : [];
      const stepIndexes = suppliedStepIndexes.length > 0
        ? [...new Set(
            suppliedStepIndexes
              .map((value: unknown) => Number(value))
              .filter((index: number) => Number.isInteger(index))
              .map((index: number) => oneBasedValidationIndexes ? index - 1 : index)
              .filter((index: number) => index >= 0 && index < steps.length),
          )]
        : steps.flatMap((step, index) => step.operation === "preserve" ? [] : [index]);
      return {
        stepIndexes,
        kind,
        ...(command ? { command } : {}),
        ...(typeof validation?.cwd === "string" && validation.cwd.trim()
          ? { cwd: validation.cwd.trim() }
          : {}),
        expectedOutcome: String(
          validation?.expectedOutcome ||
          validation?.outcome ||
          command ||
          "修改后的行为符合计划中的预期结果。",
        ).trim(),
        required:
          validation?.required !== false &&
          kind !== "assertion" &&
          kind !== "advisory",
      };
    },
  ) as Array<WorkPlanDraftV1["validations"][number]>;
  const executableStepIndexes = steps.flatMap((step, index) =>
    step.operation === "preserve" ? [] : [index]
  );
  const firstRequiredValidation = validations.findIndex(
    (validation) => validation.required,
  );
  if (firstRequiredValidation >= 0) {
    const covered = new Set(validations.flatMap((validation) =>
      validation.required ? validation.stepIndexes : []
    ));
    const uncovered = executableStepIndexes.filter((index) => !covered.has(index));
    if (uncovered.length > 0) {
      const validation = validations[firstRequiredValidation]!;
      validations[firstRequiredValidation] = {
        ...validation,
        stepIndexes: [...new Set([...validation.stepIndexes, ...uncovered])],
      };
    }
  }
  const draft: WorkPlanDraftV1 = {
    schemaVersion: WORK_PLAN_V1_SCHEMA_VERSION,
    objective: raw.objective,
    summary: raw.summary,
    findings: (Array.isArray(raw.findings) ? raw.findings : []).map((finding) => ({
      statement: String(finding?.statement || ""),
      basis: knownBasis(finding?.basis),
    })),
    steps,
    validations,
    risks: stringList(raw.risks),
    assumptions: stringList(raw.assumptions),
    blockingQuestions: stringList(raw.blockingQuestions),
  };
  return {
    draft,
    normalized: JSON.stringify(draft) !== JSON.stringify(raw),
  };
}
