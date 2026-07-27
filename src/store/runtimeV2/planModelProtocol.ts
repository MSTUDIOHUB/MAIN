import type { AgentMessage } from "../../lib/agentMessages";
import { TOOL_DEFINITIONS, type ToolDefinition } from "../../lib/toolSchemas";
import {
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

export type PlanModelStage = "discovery" | "synthesis";
export type PlanProviderTransport = "native_tool" | "structured_response";

export function isPlanSubmissionStage(stage: PlanModelStage): boolean {
  return stage === "synthesis";
}

/**
 * Providers that ignore native tool_choice may still support a constrained
 * response format. The result must pass the same WorkPlan compiler and
 * validator as a native call; this schema does not grant lifecycle authority.
 */
export const WORK_PLAN_STRUCTURED_RESPONSE_FORMAT: Readonly<Record<string, unknown>> = {
  type: "json_schema",
  json_schema: {
    name: "runtime_v2_work_plan_submission",
    strict: false,
    schema: SUBMIT_WORK_PLAN_TOOL.function.parameters,
  },
};

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
  readonly compactRecovery: boolean;
  readonly transport: PlanProviderTransport;
}): AgentMessage[] {
  let lastSubmissionOutcomeIndex = -1;
  for (let index = input.messages.length - 1; index >= 0; index -= 1) {
    const message = input.messages[index]!;
    if (
      message.role === "tool" &&
      /^WORK_PLAN_REJECTED\b/.test(
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
        [
          input.transport === "structured_response"
            ? "The read-only discovery window is closed. Return exactly one JSON object matching the supplied runtime_v2_work_plan_submission schema. Do not add prose or a Markdown fence."
            : "The read-only discovery window is closed. Call submit_runtime_v2_work_plan now; no other tool is available.",
          "Before submitting, reconcile the retained evidence into a concrete causal chain and include only source owners that the evidence supports.",
          "Use observable bounded validation. Do not put dev servers or manual instructions in finite command fields.",
        ].join(" "),
      ].join(" "),
    },
  ];
}

export {
  decodeExactStructuredPlanResponse,
  decodeStructuredPlanArguments,
  safeJsonParse,
  workPlanDraftFromSubmission,
} from "./workPlanSubmission";

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
