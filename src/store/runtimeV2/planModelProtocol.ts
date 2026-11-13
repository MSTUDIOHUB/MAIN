import type { AgentMessage } from "../../lib/agentMessages";
import { PLAN_CLARIFICATION_GUIDANCE, PLAN_QUESTION_TOOL } from "./planQuestionTool";
import type { StreamResult } from "../../lib/streaming";
import {
  READ_ONLY_SUBAGENT_ACCESS_MODES,
  READ_ONLY_SUBAGENT_TASK_KINDS,
  TOOL_DEFINITIONS,
  type ToolDefinition,
} from "../../lib/toolSchemas";
import type { RuntimeV2Objective, RuntimeV2ProviderDiagnostic, WorkPlanRuntimeEvidence } from "../../lib/runtime-v2";
import type { ConversationTurn } from "../../lib/workflowModels";
import type { RuntimeV2SubmissionContext } from "./submissionContext";
import { resolveRuntimeV2ObjectiveAdmission } from "./submissionContext";
import {
  buildSubagentDelegationGuidance,
} from "../../lib/turnIntake";
import { buildLoadSkillToolDefinition } from "../../lib/agentSkills";
import { filterToCoreAndUnlockedTools } from "../../lib/toolSearch";
import { RUNTIME_V2_WORKSPACE_NETWORK_READ_TOOL_NAMES } from "../../lib/runtime-v2/workspaceReadPolicy";
import { normalizeNetworkRead } from "../../lib/networkRead";
import { normalizeKnowledgeReferences, renderKnowledgeContextAnchor } from "../../lib/knowledgeReferences";
import { containsProviderTextEnvelopePrompt } from "./executionProviderContext";
import { buildRuntimeV2TextEnvelopeCatalog } from "./executionProviderTools";
import { renderPlanSkillContext } from "./planSkillContext";
import { unityMcpObservationTools, UNITY_MCP_OBSERVATION_NAMES } from "../../lib/workspaceMcp";

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
  "knowledge_search",
  "knowledge_get_excerpt",
  ...UNITY_MCP_OBSERVATION_NAMES,
]);

export const SUBMIT_WORK_PLAN_TOOL: ToolDefinition = {
  type: "function",
  function: {
    name: SUBMIT_WORK_PLAN_TOOL_NAME,
    description:
      "提交可审阅的实现计划。必须提供 Markdown 方案说明（planMarkdown）、文件变更步骤（changes）及验证方式（validations）。主动核实可用的构建、测试或交互检查，将能判定通过或失败的检查写入 validations。仅当完成计划取决于用户决定时才追问。不要编造命令。省略的依赖关系与准则映射由运行时自动推断。",
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
          minItems: 1,
          description: "必填，说明如何验证计划满足已接纳的验收准则；不要只在 Markdown 中描述验证。",
          items: {
            type: "object",
            properties: {
              kind: {
                type: "string",
                enum: ["finite_command", "browser", "desktop", "assertion", "advisory"],
                description: "finite_command、browser、desktop 可提供必要验收；assertion、advisory 仅作说明，不提供必要验收覆盖。计划阶段只描述验证，不执行。",
              },
              command: {
                type: "string",
                description: "可选，用于验证的构建/测试/检查命令（如 npm run build）",
              },
              cwd: { type: "string", description: "工作区相对目录，根目录用 ." },
              expectedTestCases: { type: "integer", description: "为 Unity 测试定义了确定的用例集时填正整数用例数。运行时要求该数量全部通过。" },
              useProjectEditor: { type: "boolean", description: "Unity 或团结 PlayMode 验收设置为 true。命令用 unity test . --mode PlayMode --filter SuiteName，填写确定的正整数用例数。审批涵盖同一工程版本和测试筛选的在线与批处理方式。" },
              expectedOutcome: {
                type: "string",
                description: "预期的验证通过结果说明",
              },
              required: { type: "boolean", description: "可选，finite_command、browser、desktop 默认 true；assertion、advisory 始终为 false，即使填写 true。" },
              stepIndexes: {
                type: "array",
                items: { type: "integer" },
                description: "该检查覆盖的 changes[] 零基下标。Unity PlayMode 测试覆盖场景时也应引用创建场景和引导脚本的步骤。",
              },
              criterionIds: {
                type: "array",
                items: { type: "string" },
                description: "可选，对应的已接纳验收准则 ID；省略时自动映射。",
              },
            },
            required: ["expectedOutcome"],
          },
        },
        questions: {
          type: "array",
          items: { type: "string" },
          description: "可选，仅填写会阻止方案完成、且须用户回答的具体问题；运行时会展示问题并等待回答。工具可用时优先调用 ask_plan_questions。",
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

/** Full admitted read-only catalog, shared by discovery and provider filtering. */
export function planModelToolCandidates(
  context: RuntimeV2SubmissionContext,
): ToolDefinition[] {
  const includeNetwork = normalizeNetworkRead(context.networkRead).enabled;
  const loadSkill = buildLoadSkillToolDefinition(context.skillCatalog);
  const knowledgeReferences = normalizeKnowledgeReferences(context.knowledgeContext?.references);
  const baseTools = TOOL_DEFINITIONS.filter((definition) => {
    const name = definition.function.name;
    if ((name === "knowledge_search" || name === "knowledge_get_excerpt") && (!knowledgeReferences?.length || ["stale", "error"].includes(context.knowledgeContext?.state || ""))) return false;
    return PLAN_READ_ONLY_TOOL_NAMES.has(name) ||
      (includeNetwork && RUNTIME_V2_WORKSPACE_NETWORK_READ_TOOL_NAMES.has(name));
  });
  return [
    ...baseTools,
    ...(context.workspaceMcpSnapshot?.planObservationsAllowed ? unityMcpObservationTools(context.workspaceMcpSnapshot) : []),
    ...(loadSkill ? [loadSkill] : []),
  ];
}

export function planModelTools(context: RuntimeV2SubmissionContext): ToolDefinition[] {
  const canAskPlanQuestions = !!(context.planPurpose || context.sourcePlanDraft);
  return filterToCoreAndUnlockedTools([...planModelToolCandidates(context), ...(canAskPlanQuestions ? [PLAN_QUESTION_TOOL] : []), SUBMIT_WORK_PLAN_TOOL], {
    sessionKey: context.runSessionKey,
    alwaysInclude: [SUBMIT_WORK_PLAN_TOOL_NAME, ...UNITY_MCP_OBSERVATION_NAMES,
      ...(context.knowledgeContext?.references.length ? ["knowledge_search", "knowledge_get_excerpt"] : []),
      ...(canAskPlanQuestions ? [PLAN_QUESTION_TOOL.function.name] : [])],
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
  readonly submissionRepairPending?: boolean;
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

export const WORK_PLAN_VALIDATION_REPAIR_FORMAT = {
  type: "json_schema",
  json_schema: {
    name: "runtime_v2_work_plan_validation_repair",
    strict: false,
    schema: { type: "object", additionalProperties: false,
      properties: {
        planMarkdown: { type: "string", description: "Preserve the existing implementation plan, correcting any description of the rejected validations." },
        validations: SUBMIT_WORK_PLAN_TOOL.function.parameters!.properties!.validations,
      },
      required: ["planMarkdown", "validations"] },
  },
} as const;

export function applyWorkPlanValidationRepair(
  repair: { candidate: Record<string, unknown>; rejectedCommands: readonly string[] },
  result: Record<string, unknown> | null,
): Record<string, unknown> | null {
  if (!result || Object.keys(result).length !== 2 || !Array.isArray(result.validations) ||
    !result.validations.length || typeof result.planMarkdown !== "string" || !result.planMarkdown.trim()) return null;
  const markdown = result.planMarkdown;
  if (repair.rejectedCommands.some(command => markdown.includes(command))) return null;
  return { ...repair.candidate, planMarkdown: markdown, validations: result.validations };
}

/** Request-local decision view. Old rejected plans and Skill receipts remain
 * in the canonical transcript for ordinary investigation and cold recovery. */
export function validationRepairTranscript(input: {
  readonly objective: RuntimeV2Objective | undefined;
  readonly decisionJournal: string | undefined;
  readonly candidate: Record<string, unknown>;
  readonly feedback: string;
}): AgentMessage[] {
  return [
    { role: "system", content: "Repair only acceptance for this WorkPlan. Return a JSON object with planMarkdown and validations. Preserve the confirmed intent and implementation steps. Plan only; do not execute a check." },
    { role: "user", content: [input.objective?.text, input.decisionJournal].filter(Boolean).join("\n\n") },
    { role: "system", content: [
      `Unchanged implementation steps: ${JSON.stringify(input.candidate.changes)}`,
      `Admitted constraints: ${JSON.stringify(input.objective?.constraints || [])}`,
      `Admitted acceptance criteria: ${JSON.stringify(input.objective?.acceptanceCriteria || [])}`,
      input.feedback,
      "Write the narrative from the unchanged steps and corrected checks. Use the finite test runner described in the feedback when applicable; the previous editor probes do not establish a test result. Each required check must fail when the stated behavior is wrong. Use zero-based stepIndexes and retain the admitted criterion IDs.",
    ].join("\n\n") },
  ];
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
  readonly overview?: string;
  readonly objective?: RuntimeV2Objective;
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
  const workspaceInstructions = String(
    input.context.workspaceInstructionContext || "",
  ).trim();
  const criteria = input.objective
    ? input.objective.acceptanceCriteria.map((text, index) => ({
        id: input.objective?.acceptanceCriterionIds?.[index] || `criterion-${index + 1}`,
        text,
      }))
    : resolveRuntimeV2ObjectiveAdmission(input.context, input.turn.userPrompt).acceptanceCriteria;
  return [
    {
      role: "system",
      content: [
        "[MAIN RUNTIME V2 PLAN]",
        `Workspace: ${input.context.runWorkspace || "global"}`,
        `Respond in: ${language}`,
        "You are in Plan Mode: inspect relevant files with read-only tools and then submit a clear plan via submit_runtime_v2_work_plan.",
        "Do not invent file paths or modify project files during planning.",
        "Use prior read receipts as evidence. Inspect the smallest missing fact about a test entry point, fixture, or interaction capability. Use a relevant admitted Skill when it can identify the check. If adding a test is in scope and the project has a suitable runner, plan that test as a change and bind the runnable check to it. Design the check yourself; ask only for a consequential scope, constraint, or acceptance decision that safe inspection cannot resolve.",
        ...(input.context.projectBaselineContext?.facts.runtimes.some(runtime => ["unity", "tuanjie"].includes(runtime.name)) ? [
          "For Unity or Tuanjie tests, check the project's existing test and runtime assembly definitions and references. Include each necessary .asmdef in the reviewed changes, with dependencies. A PlayMode test using yield must return IEnumerator. Bind PlayMode to a named suite with useProjectEditor and expectedTestCases so the same reviewed check can use the exact Editor or batch mode.",
        ] : []),
        "When ready, call submit_runtime_v2_work_plan with planMarkdown, changes, and validations. Record each runnable check as a structured validation with its working directory where needed and its concrete expected outcome. Keep manual checks as supplemental assertions.",
        "Implementation acceptance normally needs a runnable behavioral test, executable assertion, or supported interaction that observes the user's outcome. Build, lint and typecheck are supplemental unless the admitted criterion explicitly asks for static verification.",
        `[ADMITTED CRITERIA]\n${criteria.map((criterion) => `${criterion.id}: ${criterion.text}`).join("\n")}`,
        collaborationRequired
          ? "[REQUIRED COLLABORATION]\nThe user explicitly requires a planning child. Before submitting, admit at least one bounded read-only child through spawn_subagent, later join it, assess its result, and cite any adopted exact evidence ID. This is a hard admission condition, not a collaboration preference."
          : "",
        input.context.planPurpose || input.context.sourcePlanDraft ? PLAN_CLARIFICATION_GUIDANCE : "Use questions only for a real user-owned decision.",
        collaborationGuidance
          ? `[COLLABORATION METHOD]\n${collaborationGuidance}`
          : "",
        workspaceInstructions
          ? `[LIVE WORKSPACE INSTRUCTIONS]\n${workspaceInstructions}`
          : "",
        ...(input.context.planPurpose ? ["The plan document must retain the confirmed choices, not label them assumptions. MAIN appends their canonical decision journal; do not repeat ID JSON. Use ask_plan_questions when a material method or scope decision remains. Answers provide information only; execution still requires separate exact Plan review."] : []),
      renderKnowledgeContextAnchor(input.context.knowledgeContext),
        renderPlanSkillContext(input.context, input.turn.userPrompt),
      ].join("\n"),
    },
    { role: "user", content: input.turn.userPrompt },
    ...(input.overview !== undefined ? [{
      role: "user" as const,
      content: `[E1] workspace overview\n${boundedPlanContent(input.overview, 12_000)}`,
    }] : []),
  ];
}

export function boundedPlanTranscript(
  messages: readonly AgentMessage[],
): AgentMessage[] {
  return [...messages];
}

export function planTextEnvelopeTranscript(messages: readonly AgentMessage[], tools: readonly ToolDefinition[],
  language: "zh" | "en"): AgentMessage[] {
  return [
    ...messages,
    { role: "system", content: containsProviderTextEnvelopePrompt(language, true) },
    { role: "system", content: buildRuntimeV2TextEnvelopeCatalog(tools) },
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

export function synthesisPlanTranscript(input: {
  readonly messages: readonly AgentMessage[];
  readonly evidence: readonly WorkPlanRuntimeEvidence[];
  readonly evidenceContents: ReadonlyMap<string, string>;
  readonly submissionRepairPending: boolean;
  readonly compactRecovery: boolean;
  readonly transport: PlanProviderTransport;
  readonly canAskPlanQuestions?: boolean;
}): AgentMessage[] {
  return [
    ...input.messages,
    {
      role: "system",
      content: [
        input.submissionRepairPending
          ? input.transport === "structured_response"
            ? "Correct the rejected WorkPlan using the exact feedback and retained source receipts."
            : "Correct the rejected WorkPlan using the exact feedback and retained source receipts. Authorized read-only tools remain available when one named missing path, range, or fact is needed to repair the plan."
          : "Synthesize the retained source receipts into one evidence-grounded WorkPlan.",
        input.transport === "structured_response"
          ? "Return exactly one JSON object matching the supplied runtime_v2_work_plan_submission schema, without prose or Markdown fences."
          : "Read only a specific missing fact, or call submit_runtime_v2_work_plan with the complete plan.",
        input.canAskPlanQuestions && (input.transport === "structured_response"
          ? "If a consequential new user decision blocks completion, put the specific question in the questions field so MAIN pauses for an answer. Treat explicit requirements in the original request and confirmed answers as resolved decisions."
          : PLAN_CLARIFICATION_GUIDANCE),
        "Preserve every admitted criterion, dependency edge and bounded validation. Cite the exact IDs of any adopted child evidence. A rejected submission is not a new fact or approval.",
      ].filter(Boolean).join(" "),
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
