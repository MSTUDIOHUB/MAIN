import type { AgentMessage } from "../../lib/agentMessages";
import type { StreamResult } from "../../lib/streaming";
import {
  READ_ONLY_SUBAGENT_ACCESS_MODES,
  READ_ONLY_SUBAGENT_TASK_KINDS,
  TOOL_DEFINITIONS,
  type ToolDefinition,
} from "../../lib/toolSchemas";
import type { RuntimeV2ProviderDiagnostic, WorkPlanRuntimeEvidence } from "../../lib/runtime-v2";
import type { ConversationTurn } from "../../lib/workflowModels";
import type { RuntimeV2SubmissionContext } from "./submissionContext";
import { resolveRuntimeV2ObjectiveAdmission } from "./submissionContext";
import {
  buildSubagentDelegationGuidance,
} from "../../lib/turnIntake";
import {
  buildLoadSkillToolDefinition,
  renderExplicitSkillActivationContext,
  renderSkillCatalogContext,
  skillCatalogContextCharBudget,
} from "../../lib/agentSkills";
import { filterToCoreAndUnlockedTools } from "../../lib/toolSearch";
import { RUNTIME_V2_WORKSPACE_NETWORK_READ_TOOL_NAMES } from "../../lib/runtime-v2/workspaceReadPolicy";

export const SUBMIT_WORK_PLAN_TOOL_NAME = "submit_runtime_v2_work_plan";
export const PLAN_MODEL_REQUEST_TIMEOUT_MS = 90_000;
export const PLAN_SYNTHESIS_REQUEST_TIMEOUT_MS = 3 * 60_000;
export const PLAN_CONTEXT_RESULT_CHARS = 10_000;
export const PLAN_SYNTHESIS_RECOVERY_REQUEST_TIMEOUT_MS = 90_000;
export const PLAN_SYNTHESIS_RECOVERY_MAX_TOKENS = 4_096;

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
  "load_skill",
  "tool_search",
]);

export const SUBMIT_WORK_PLAN_TOOL: ToolDefinition = {
  type: "function",
  function: {
    name: SUBMIT_WORK_PLAN_TOOL_NAME,
    description:
      "提交可审阅的实现计划（不会直接修改项目文件）。只需提供 Markdown 方案说明（planMarkdown）、文件变更步骤（changes）及可选的验证方式（validations），依赖关系与准则映射由运行时自动推断。",
    parameters: {
      type: "object",
      properties: {
        planMarkdown: {
          type: "string",
          description:
            "清晰的 Markdown 计划正文（包含问题诊断、设计思路与关键注意事项）。",
        },
        changes: {
          type: "array",
          minItems: 1,
          items: {
            type: "object",
            properties: {
              title: { type: "string", description: "步骤简短标题" },
              operation: {
                type: "string",
                enum: ["modify", "create", "delete", "preserve"],
                description: "操作类型，默认为 modify",
              },
              targets: {
                type: "array",
                minItems: 1,
                items: { type: "string" },
                description: "涉及的工作区相对文件路径列表",
              },
              change: {
                type: "string",
                description: "具体的代码或行为改动说明",
              },
              expectedOutcome: { type: "string", description: "可选，预期结果" },
              basis: {
                type: "array",
                items: { type: "string" },
                description: "可选，支撑该步骤的证据 ID（如 E1、E2）",
              },
              dependsOn: {
                type: "array",
                items: { type: "integer" },
                description: "可选，前置步骤的 0-based 索引列表，默认自动推断",
              },
              criterionIds: {
                type: "array",
                items: { type: "string" },
                description: "可选，对应的验收准则 ID，默认自动映射",
              },
            },
            required: ["targets", "change"],
          },
        },
        validations: {
          type: "array",
          items: {
            type: "object",
            properties: {
              kind: {
                type: "string",
                enum: ["finite_command", "browser", "desktop", "assertion", "advisory"],
              },
              command: {
                type: "string",
                description: "可选，用于验证的构建/测试/检查命令（如 npm run build）",
              },
              cwd: { type: "string" },
              expectedOutcome: {
                type: "string",
                description: "预期的验证通过结果说明",
              },
              required: { type: "boolean" },
              stepIndexes: {
                type: "array",
                items: { type: "integer" },
              },
              criterionIds: {
                type: "array",
                items: { type: "string" },
              },
            },
            required: ["expectedOutcome"],
          },
        },
        questions: {
          type: "array",
          items: { type: "string" },
          description: "可选，确需用户决策的问题；无阻塞问题时省略。",
        },
      },
      required: ["planMarkdown", "changes"],
    },
  },
};

export const PLAN_MODEL_TOOLS = [
  ...TOOL_DEFINITIONS.filter((definition) =>
    PLAN_READ_ONLY_TOOL_NAMES.has(definition.function.name)
  ),
  SUBMIT_WORK_PLAN_TOOL,
];

export function planModelTools(
  context: RuntimeV2SubmissionContext,
  state?: any,
): ToolDefinition[] {
  const includeNetwork = state?.webSearchEnabled === true;
  const loadSkill = buildLoadSkillToolDefinition(context.skillCatalog);
  const baseTools = TOOL_DEFINITIONS.filter((definition) => {
    const name = definition.function.name;
    return PLAN_READ_ONLY_TOOL_NAMES.has(name) ||
      (includeNetwork && RUNTIME_V2_WORKSPACE_NETWORK_READ_TOOL_NAMES.has(name));
  });
  const allCandidates = [
    ...baseTools,
    ...(loadSkill ? [loadSkill] : []),
    SUBMIT_WORK_PLAN_TOOL,
  ];
  return filterToCoreAndUnlockedTools(allCandidates, {
    sessionKey: context.runSessionKey,
    alwaysInclude: [SUBMIT_WORK_PLAN_TOOL_NAME],
  });
}

function planCollaborationTool(name: "spawn_subagent" | "wait_subagents"):
  ToolDefinition | null {
  const source = TOOL_DEFINITIONS.find((definition) =>
    definition.function.name === name
  );
  if (!source) return null;
  if (name === "wait_subagents") return source;
  const properties = { ...source.function.parameters.properties };
  delete properties.implementation_operation;
  delete properties.implementation_plan;
  return {
    ...source,
    function: {
      ...source.function,
      description: [
        "Create one bounded read-only planning child for independent investigation, review, or validation design.",
        "The parent must continue unrelated discovery and later join the child before submitting the WorkPlan.",
        "Planning children cannot modify or stage workspace files.",
      ].join(" "),
      parameters: {
        ...source.function.parameters,
        properties: {
          ...properties,
          task_kind: {
            ...properties.task_kind,
            enum: [...READ_ONLY_SUBAGENT_TASK_KINDS],
          },
          access_mode: {
            ...properties.access_mode,
            enum: [...READ_ONLY_SUBAGENT_ACCESS_MODES],
          },
        },
      },
    },
  };
}

const PLAN_SPAWN_SUBAGENT_TOOL = planCollaborationTool("spawn_subagent");
const PLAN_WAIT_SUBAGENTS_TOOL = planCollaborationTool("wait_subagents");

export function selectPlanModelTools(input: {
  readonly submissionStage: boolean;
  readonly collaborationAllowed: boolean;
  readonly collaborationRequired?: boolean;
  readonly collaborationRequirementMet?: boolean;
  readonly remainingSubagentCapacity: number;
  readonly activeSubagentCount: number;
  readonly baseTools?: readonly ToolDefinition[];
}): ToolDefinition[] {
  if (
    input.collaborationRequired === true &&
    input.collaborationRequirementMet !== true
  ) {
    return input.collaborationAllowed &&
        input.remainingSubagentCapacity > 0 &&
        PLAN_SPAWN_SUBAGENT_TOOL
      ? [PLAN_SPAWN_SUBAGENT_TOOL]
      : [];
  }
  if (input.submissionStage) return [SUBMIT_WORK_PLAN_TOOL];
  const tools = [...(input.baseTools || PLAN_MODEL_TOOLS)];
  if (
    input.collaborationAllowed &&
    input.remainingSubagentCapacity > 0 &&
    PLAN_SPAWN_SUBAGENT_TOOL
  ) {
    tools.splice(tools.length - 1, 0, PLAN_SPAWN_SUBAGENT_TOOL);
  }
  if (input.activeSubagentCount > 0 && PLAN_WAIT_SUBAGENTS_TOOL) {
    tools.splice(tools.length - 1, 0, PLAN_WAIT_SUBAGENTS_TOOL);
  }
  return tools;
}

export type PlanModelStage = "discovery" | "synthesis";
export type PlanProviderTransport =
  | "native_tool"
  | "text_envelope"
  | "structured_response";

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
  readonly subagentRequirement?: "optional" | "required";
}): AgentMessage[] {
  const language = input.context.phaseLanguage === "en" ? "English" : "简体中文";
  const collaborationRequired = (
    input.subagentRequirement ??
    input.context.turnInputContextSignals?.subagentRequirement ??
    "optional"
  ) === "required";
  const collaborationGuidance = collaborationRequired
    ? ""
    : buildSubagentDelegationGuidance({
        preference:
          input.context.turnInputContextSignals?.subagentPreference ||
            "unspecified",
        language: input.context.phaseLanguage,
      });
  const skillCatalog = renderSkillCatalogContext(
    input.context.skillCatalog,
    skillCatalogContextCharBudget(
      input.context.runtimeContextBudget?.contextLimit,
    ),
  );
  const explicitSkills = renderExplicitSkillActivationContext(
    input.context.skillCatalog,
    { maxChars: skillCatalogContextCharBudget(input.context.runtimeContextBudget?.contextLimit) },
  );
  const workspaceInstructions = String(
    input.context.workspaceInstructionContext || "",
  ).trim();
  const admission = resolveRuntimeV2ObjectiveAdmission(
    input.context,
    input.turn.userPrompt,
  );
  return [
    {
      role: "system",
      content: [
        "[MAIN RUNTIME V2 PLAN]",
        `Workspace: ${input.context.runWorkspace || "global"}`,
        `Respond in: ${language}`,
        "You are in Plan Mode: inspect relevant files with read-only tools and then submit a clear plan via submit_runtime_v2_work_plan.",
        "Do not invent file paths or modify project files during planning.",
        "When you have enough context, call submit_runtime_v2_work_plan once with planMarkdown (narrative diagnosis & design), changes (each with targets and change description), and validations (bounded build/test commands or expected outcomes).",
        `[ADMITTED CRITERIA]\n${admission.acceptanceCriteria.map((criterion) => `${criterion.id}: ${criterion.text}`).join("\n")}`,
        collaborationRequired
          ? "[REQUIRED COLLABORATION]\nThe user explicitly requires a planning child. Before submitting, admit at least one bounded read-only child through spawn_subagent, later join it, assess its result, and cite any adopted exact evidence ID. This is a hard admission condition, not a collaboration preference."
          : "",
        "Use questions only for a real user-owned decision.",
        collaborationGuidance
          ? `[COLLABORATION METHOD]\n${collaborationGuidance}`
          : "",
        workspaceInstructions
          ? `[LIVE WORKSPACE INSTRUCTIONS]\n${workspaceInstructions}`
          : "",
        skillCatalog,
        explicitSkills,
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
  return [...messages];
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

export function synthesisPlanTranscript(input: {
  readonly messages: readonly AgentMessage[];
  readonly evidence: readonly WorkPlanRuntimeEvidence[];
  readonly evidenceContents: ReadonlyMap<string, string>;
  readonly submissionRepairPending: boolean;
  readonly compactRecovery: boolean;
  readonly transport: PlanProviderTransport;
}): AgentMessage[] {
  return [
    ...input.messages,
    {
      role: "system",
      content: [
        input.submissionRepairPending
          ? "Correct the rejected WorkPlan using the exact feedback and retained source receipts. This request exposes only the effect-free submission ingress; do not investigate again."
          : "Synthesize the retained source receipts into one evidence-grounded WorkPlan.",
        input.transport === "structured_response"
          ? "Return exactly one JSON object matching the supplied runtime_v2_work_plan_submission schema, without prose or Markdown fences."
          : "Call submit_runtime_v2_work_plan once with the complete plan.",
        "Preserve every admitted criterion, dependency edge and bounded validation. Cite the exact IDs of any adopted child evidence. A rejected submission is not a new fact or approval.",
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


export function planProviderResponseDiagnostics(input: {
  readonly protocolViolation: StreamResult["protocolViolation"];
  readonly clientStopReason: StreamResult["clientStopReason"];
  readonly outputTruncated: boolean;
  readonly adaptedToolCallCount: number;
  readonly structuredResponseAdapted: boolean;
}): RuntimeV2ProviderDiagnostic[] {
  return [
    ...(input.protocolViolation
      ? [{ code: input.protocolViolation, message: "Plan tool protocol mismatch", retryable: true }]
      : []),
    ...(input.outputTruncated && input.adaptedToolCallCount === 0
      ? [{
          code: "output_truncated",
          message: input.clientStopReason
            ? `Client ${input.clientStopReason} guard ended Plan output before a complete structured submission.`
            : "Plan output reached its token limit before a complete structured submission.",
          retryable: true,
        }]
      : []),
    ...(input.structuredResponseAdapted
      ? [{
          code: "structured_response_adapted",
          message: "A complete schema-bound response was normalized as the sole Plan submission.",
          retryable: false,
        }]
      : []),
  ];
}
