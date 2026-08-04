// lib/toolSchemas.ts
// Tool definitions in OpenAI-compatible format for native function calling.
// This is what Ollama / LM Studio / OpenAI expect in the `tools` parameter.
// ────────────────────────────────────────────────────────────────────

import type { Skill } from "./appTypes";
import type { MCPTool } from "./mcpClient";
import {
  SUPPORTED_BROWSER_INTERACTION_ACTION_KINDS,
  SUPPORTED_DESKTOP_INTERACTION_ACTION_KINDS,
  SUPPORTED_INTERACTION_ASSERTION_KINDS,
} from "./validationContract";

export interface ToolParameterSchema {
  type?: string;
  description?: string;
  /**
   * Internal execution-identity annotation. Optional arguments equal to this
   * value are canonicalized as omitted before replay detection. Schema
   * normalization removes the annotation before any provider request.
   */
  runtimeIdentityDefault?: unknown;
  enum?: string[];
  properties?: Record<string, ToolParameterSchema>;
  items?: ToolParameterSchema;
  required?: string[];
  minItems?: number;
  anyOf?: ToolParameterSchema[];
  not?: ToolParameterSchema;
  additionalProperties?: boolean | ToolParameterSchema;
}

export interface ToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: {
      type: "object";
      properties: Record<string, ToolParameterSchema>;
      required: string[];
    };
  };
}

export const SUBMIT_PLAN_CANDIDATE_TOOL_NAME = "submit_plan_candidate";

const PLAN_EXPECTED_SCALAR_SCHEMA = {
  anyOf: [
    { type: "string" },
    { type: "number" },
    { type: "boolean" },
    { type: "null" },
  ],
  description: "Expected scalar value. Strings, numbers, booleans, and null use the same contract on native-tool and text-envelope transports.",
};

const PLAN_READINESS_EXPECTED_SCALAR_SCHEMA = {
  anyOf: [
    { type: "string" },
    { type: "number" },
    { type: "boolean" },
  ],
  description: "Expected service-readiness value. Strings, numbers, and booleans use the same contract on native-tool and text-envelope transports.",
};

const PLAN_INTERACTION_ASSERTION_SCHEMA = {
  type: "object",
  properties: {
    kind: {
      type: "string",
      enum: [...SUPPORTED_INTERACTION_ASSERTION_KINDS],
    },
    target: { type: "string" },
    afterActionId: {
      type: "string",
      description: "ID of the action that must precede and cause this assertion. Required whenever actions are present.",
    },
    expected: { ...PLAN_EXPECTED_SCALAR_SCHEMA },
  },
  required: ["kind", "target"],
};

function planInteractionActionSchema(kinds: readonly string[]) {
  return {
    type: "object",
    properties: {
      id: {
        type: "string",
        description: "Stable action ID. Required so a post-action assertion can name the exact causal action.",
      },
      kind: {
        type: "string",
        enum: [...kinds],
      },
      target: { type: "string" },
    },
    required: ["id", "kind", "target"],
  };
}

const PLAN_VALIDATION_PRIMITIVE_SCHEMA = {
  description: "Tagged validation primitive. Select exactly one kind branch and provide every field required by that branch; shared typed ingress performs semantic validation after transport decoding.",
  oneOf: [
    {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["finite_command"] },
        command: { type: "string" },
        cwd: { type: "string" },
        timeoutMs: { type: "number" },
        description: { type: "string" },
      },
      required: ["kind", "command"],
    },
    {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["service_observation"] },
        launchCommand: { type: "string" },
        cwd: { type: "string" },
        ownerKey: { type: "string" },
        readiness: {
          type: "object",
          properties: {
            kind: { type: "string", enum: ["process_status", "output_pattern", "port", "custom"] },
            expected: { ...PLAN_READINESS_EXPECTED_SCALAR_SCHEMA },
            target: { type: "string" },
          },
          required: ["kind", "expected"],
        },
        description: { type: "string" },
      },
      required: ["kind", "launchCommand", "ownerKey", "readiness"],
    },
    {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["browser_interaction"] },
        actions: {
          type: "array",
          items: planInteractionActionSchema(SUPPORTED_BROWSER_INTERACTION_ACTION_KINDS),
        },
        assertions: {
          type: "array",
          minItems: 1,
          items: PLAN_INTERACTION_ASSERTION_SCHEMA,
        },
        requireCausalAssertion: { type: "boolean" },
        description: { type: "string" },
      },
      required: ["kind", "actions", "assertions"],
    },
    {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["desktop_interaction"] },
        actions: {
          type: "array",
          items: planInteractionActionSchema(SUPPORTED_DESKTOP_INTERACTION_ACTION_KINDS),
        },
        assertions: {
          type: "array",
          minItems: 1,
          items: PLAN_INTERACTION_ASSERTION_SCHEMA,
        },
        requireCausalAssertion: { type: "boolean" },
        description: { type: "string" },
      },
      required: ["kind", "actions", "assertions"],
    },
    {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["assertion"] },
        acceptance: {
          type: "string",
          enum: ["advisory"],
          description: "Standalone assertions are non-blocking observations and never close Plan acceptance.",
        },
        target: { type: "string" },
        matcher: {
          type: "string",
          enum: ["equals", "not_equals", "contains", "matches", "exists", "not_exists", "runtime_result"],
        },
        producer: {
          type: "string",
          enum: ["runtime_evidence_ledger", "workspace_file_state", "artifact_store"],
        },
        expected: { ...PLAN_EXPECTED_SCALAR_SCHEMA },
        description: { type: "string" },
      },
      required: ["kind", "acceptance", "target", "matcher", "producer"],
    },
    {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["advisory"] },
        note: { type: "string" },
        owner: { type: "string", enum: ["user", "external", "runtime"] },
        description: { type: "string" },
      },
      required: ["kind", "note"],
    },
  ],
};

/**
 * Runtime-control tool used only after Plan evidence has been frozen.  The
 * schema mirrors TypedPlanDraftV1 and makes each primitive's required field
 * shape explicit. Shared typed ingress still owns semantic, causal, and
 * acceptance-capability validation so every provider follows the same
 * validate/seal/render path.
 */
export const SUBMIT_PLAN_CANDIDATE_TOOL_DEFINITION = {
  type: "function",
  function: {
    name: SUBMIT_PLAN_CANDIDATE_TOOL_NAME,
    description: "Submit the complete typed Plan graph for runtime validation and review. This is a runtime control action: it never writes files or executes the Plan. Submit one complete replacement object; use textual <user_options> instead only when a genuinely user-owned choice blocks planning.",
    parameters: {
      type: "object",
      properties: {
        schemaVersion: {
          type: "number",
          description: "Typed Plan draft schema version. Must be 2.",
        },
        evidenceRefs: {
          type: "array",
          description: "Frozen evidence IDs used by this Plan, such as E1. Include every E listed by runtime Q coverage obligations.",
          items: { type: "string" },
        },
        goalEvidenceBases: {
          type: "array",
          description: "Explicit semantic G-to-B mapping. Assign every required B and at least one selected B to every G. Optional B may be omitted; one G may use several B, but one B cannot be assigned to different goals.",
          items: {
            type: "object",
            properties: {
              goalRef: { type: "string" },
              componentRef: { type: "string" },
              evidenceRefs: { type: "array", items: { type: "string" } },
              ownerRefs: { type: "array", items: { type: "string" } },
              relationRefs: { type: "array", items: { type: "string" } },
              diagnosisRefs: { type: "array", items: { type: "string" } },
            },
            required: ["goalRef", "componentRef", "evidenceRefs", "ownerRefs", "relationRefs", "diagnosisRefs"],
          },
        },
        summary: {
          type: "array",
          description: "Short review summary lines. May be empty.",
          items: { type: "string" },
        },
        diagnoses: {
          type: "array",
          description: "Root-cause or inference nodes with explicit evidence and goal edges.",
          items: {
            type: "object",
            properties: {
              id: { type: "string", description: "Unique R-number ID, for example R1." },
              text: { type: "string", description: "Diagnosis statement." },
              certainty: {
                type: "string",
                enum: ["observed", "inferred", "hypothesis"],
                description: "Evidence status of this diagnosis.",
              },
              evidenceRefs: { type: "array", items: { type: "string" } },
              goalRefs: { type: "array", items: { type: "string" } },
              chainRefs: { type: "array", items: { type: "string" } },
            },
            required: ["id", "text", "certainty", "evidenceRefs", "goalRefs", "chainRefs"],
          },
        },
        changes: {
          type: "array",
          description: "Explicit change operations. A non-mutation Plan may leave this empty and use decisions.",
          items: {
            type: "object",
            properties: {
              id: { type: "string", description: "Unique C-number ID, for example C1." },
              text: { type: "string", description: "Concrete change description." },
              targetRef: { type: "string", description: "Exact target path or boundary from frozen evidence." },
              targetOwnerRef: { type: "string", description: "For create only: an existing evidence-backed owner in the same boundary." },
              operation: {
                type: "string",
                enum: ["modify", "create", "delete", "preserve"],
              },
              evidenceRefs: { type: "array", items: { type: "string" } },
              diagnosisRefs: { type: "array", items: { type: "string" } },
              goalRefs: { type: "array", items: { type: "string" } },
              expectedOutcome: { type: "string", description: "Observable outcome of this change." },
              relationships: { type: "array", items: { type: "string" } },
              plannedValidationHarness: {
                type: "object",
                description: "Optional future executable harness created or modified by this C. V must bind it with harnessChangeRef and a structurally matching finite command.",
                properties: {
                  surface: { type: "string", enum: ["browser", "desktop"] },
                  ownerRef: { type: "string", description: "Evidence-backed owner; for create match targetOwnerRef, for modify match targetRef." },
                  binding: {
                    oneOf: [{
                      type: "object",
                      properties: {
                        kind: { type: "string", enum: ["direct_target"] },
                        targetRef: { type: "string" },
                      },
                      required: ["kind", "targetRef"],
                    }, {
                      type: "object",
                      properties: {
                        kind: { type: "string", enum: ["manifest_script"] },
                        manifestRef: { type: "string" },
                        scriptName: { type: "string" },
                      },
                      required: ["kind", "manifestRef", "scriptName"],
                    }],
                  },
                },
                required: ["surface", "ownerRef", "binding"],
              },
            },
            required: [
              "id",
              "text",
              "targetRef",
              "operation",
              "evidenceRefs",
              "diagnosisRefs",
              "goalRefs",
              "expectedOutcome",
            ],
          },
        },
        decisions: {
          type: "array",
          description: "Explicit design or preservation decisions.",
          items: {
            type: "object",
            properties: {
              id: { type: "string", description: "Unique D-number ID, for example D1." },
              text: { type: "string", description: "Decision statement." },
              disposition: { type: "string", enum: ["change", "preserve"] },
              evidenceRefs: { type: "array", items: { type: "string" } },
              diagnosisRefs: {
                type: "array",
                items: { type: "string" },
                description: "Covering R-number diagnoses for this disposition; required for relationship evidence.",
              },
              goalRefs: { type: "array", items: { type: "string" } },
            },
            required: ["id", "text", "disposition", "evidenceRefs", "diagnosisRefs", "goalRefs"],
          },
        },
        interfaces: {
          type: "array",
          description: "Public API, interface, or type impacts. May be empty.",
          items: { type: "string" },
        },
        validations: {
          type: "array",
          description: "Required validations or advisory observations with explicit V/G/C references and one runtime primitive each. Every goal still needs a required finite command or browser/desktop interaction. Interaction targets must come from runtime-observed interaction evidence and match the required execution surface.",
          items: {
            type: "object",
            properties: {
              id: { type: "string", description: "Unique V-number ID, for example V1." },
              goalRefs: { type: "array", items: { type: "string" } },
              changeRefs: { type: "array", items: { type: "string" } },
              primitive: PLAN_VALIDATION_PRIMITIVE_SCHEMA,
              harnessChangeRef: { type: "string", description: "Optional exact C reference that creates/modifies the planned executable harness used by this finite command." },
              expectedOutcome: { type: "string", description: "Decidable expected outcome." },
            },
            required: ["id", "goalRefs", "changeRefs", "primitive", "expectedOutcome"],
          },
        },
        assumptions: {
          type: "array",
          description: "Explicit non-blocking assumptions. May be empty.",
          items: { type: "string" },
        },
        blockingChoices: {
          type: "array",
          description: "Must be empty for submission. Use textual <user_options> instead when a real user choice blocks planning.",
          items: { type: "string" },
        },
      },
      required: [
        "schemaVersion",
        "evidenceRefs",
        "goalEvidenceBases",
        "summary",
        "diagnoses",
        "changes",
        "decisions",
        "interfaces",
        "validations",
        "assumptions",
        "blockingChoices",
      ],
    },
  },
} as unknown as ToolDefinition;

function cloneJsonValue<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => cloneJsonValue(item)) as T;
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, nested]) => [key, cloneJsonValue(nested)]),
    ) as T;
  }
  return value;
}

function normalizeToolSchemaNode(node: unknown): void {
  if (Array.isArray(node)) {
    node.forEach((item) => normalizeToolSchemaNode(item));
    return;
  }
  if (!node || typeof node !== "object") return;

  const schemaNode = node as Record<string, unknown>;
  delete schemaNode.runtimeIdentityDefault;
  const hasOwn = (key: string) => Object.prototype.hasOwnProperty.call(schemaNode, key);
  const hasDescription = typeof schemaNode.description === "string" && schemaNode.description.trim().length > 0;
  const hasType = typeof schemaNode.type === "string" && schemaNode.type.trim().length > 0;
  const hasNestedSchemaKeywords =
    hasOwn("properties") ||
    hasOwn("items") ||
    hasOwn("anyOf") ||
    hasOwn("oneOf") ||
    hasOwn("allOf") ||
    hasOwn("$ref") ||
    hasOwn("additionalProperties");

  if (schemaNode.type === "object") {
    const properties = schemaNode.properties;
    if (!properties || typeof properties !== "object" || Array.isArray(properties)) {
      schemaNode.properties = {};
    }
    const required = schemaNode.required;
    if (!Array.isArray(required)) {
      schemaNode.required = [];
    }
  }

  if (hasDescription && !hasType && !hasNestedSchemaKeywords) {
    schemaNode.type = "string";
  }

  Object.values(schemaNode).forEach((value) => normalizeToolSchemaNode(value));
}

export function normalizeToolParametersSchema<T>(schema: T): T {
  const cloned = cloneJsonValue(schema);
  normalizeToolSchemaNode(cloned);
  return cloned;
}

export function normalizeToolDefinition(tool: ToolDefinition): ToolDefinition {
  return {
    ...tool,
    function: {
      ...tool.function,
      parameters: normalizeToolParametersSchema(tool.function.parameters),
    },
  };
}

export function normalizeToolDefinitions(tools: ToolDefinition[]): ToolDefinition[] {
  return tools.map((tool) => normalizeToolDefinition(tool));
}

export const READ_ONLY_SUBAGENT_TASK_KINDS = [
  "explore",
  "review",
  "validate",
] as const;

export const READ_ONLY_SUBAGENT_ACCESS_MODES = ["read"] as const;

export const RUNTIME_V2_SUBAGENT_TASK_KINDS = [
  ...READ_ONLY_SUBAGENT_TASK_KINDS,
  "implement",
] as const;

export const RUNTIME_V2_SUBAGENT_ACCESS_MODES = ["read", "write"] as const;

export const RUNTIME_V2_SUBAGENT_IMPLEMENTATION_OPERATIONS = [
  "create",
  "modify",
  "delete",
] as const;

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  SUBMIT_PLAN_CANDIDATE_TOOL_DEFINITION,
  {
    type: "function",
    function: {
      name: "spawn_subagent",
      description: "按需创建一个全新的一次性子智能体。调查、评审和验证任务为只读；父线程形成明确方案后，可把互不重叠的文件所有权交给 implement 子任务并行形成一个受控修改事务。仅在存在真实并行收益时委派，父线程继续处理不重叠工作。",
      parameters: {
        type: "object",
        properties: {
          task_key: { type: "string", description: "当前父回合内稳定、简短且能表达职责的语义任务键" },
          task_kind: {
            type: "string",
            enum: [...RUNTIME_V2_SUBAGENT_TASK_KINDS],
            description: "子任务类型；explore/review/validate 为只读，implement 为明确方案下的受控实现",
          },
          objective: { type: "string", description: "子智能体要独立完成的明确目标" },
          delegation_reason: { type: "string", description: "可选：为什么该任务值得独立委派；省略时由运行时补充中性原因" },
          success_criteria: { type: "string", description: "可选：可判定的成功标准；省略时要求返回与目标相关的实质性工具证据" },
          name: { type: "string", description: "可选显示名称，如 Euler；省略时由 MAIN 自动命名" },
          role: { type: "string", description: "可选角色，如 explorer、reviewer、tester、docs" },
          scope: { type: "string", description: "可选的职责边界说明；不能替代 objective 和 success_criteria" },
          required_paths: { type: "string", description: "成功标准要求必须覆盖的精确路径；只读任务未提供 allowed_paths 时也作为其最小读取范围。implement 必须列出每个实际写入文件。" },
          allowed_paths: { type: "string", description: "权限上限，使用逗号分隔；省略时使用 required_paths，本地任务最多 6 个。write 子任务必须使用互不重叠的精确文件目标，不能用目录授权后再自行选择文件。" },
          access_mode: {
            type: "string",
            enum: [...RUNTIME_V2_SUBAGENT_ACCESS_MODES],
            description: "explore/review/validate 使用 read；仅 implement 可使用 write",
          },
          implementation_operation: {
            type: "string",
            enum: [...RUNTIME_V2_SUBAGENT_IMPLEMENTATION_OPERATIONS],
            description: "implement 必填：该子任务负责 create、modify 或 delete 中的一类修改",
          },
          implementation_plan: {
            type: "string",
            description: "implement 必填：父线程基于证据形成的具体修改方案，必须说明责任边界和预期行为，不能只写‘修复问题’",
          },
          expected_output: { type: "string", description: "可选：汇合时需要返回的证据结构或判断；省略时返回带精确目标的来源证据" },
          depends_on: { type: "string", description: "可选，依赖的 collaboration task ID 或 task_key，逗号分隔" },
          independent_review_of: { type: "string", description: "可选；仅 reviewer 用于声明对指定 task ID/task_key 的有意独立复核" },
          goal_slice_id: { type: "string", description: "可选；仅 Goal 模式用于关联父级 goal slice，普通回合不要填写" },
        },
        required: ["objective", "required_paths"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "wait_subagents",
      description: "等待并汇合当前父回合创建的一个或全部子智能体。省略 subagent_ids 时等待本回合全部子智能体；返回摘要、证据、阻塞原因和剩余工作。",
      parameters: {
        type: "object",
        properties: {
          subagent_ids: { type: "string", description: "可选，逗号分隔的子智能体 ID；省略则等待全部" },
          collaboration_task_ids: { type: "string", description: "可选，逗号分隔的一次性任务 ID；可与 subagent_ids 二选一" },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "cancel_subagent",
      description: "取消当前父回合中一个仍在活动的一次性子智能体。取消后该实例立即进入终态并关闭，永远不能再次激活；后续需要相似工作时必须创建新的语义任务。",
      parameters: {
        type: "object",
        properties: {
          subagent_id: { type: "string", description: "要取消的活动子智能体 ID" },
          collaboration_task_id: { type: "string", description: "也可使用该一次性任务 ID 定位；二者至少提供一个" },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_directory",
      description: "扫描指定目录下的文件和子目录列表。返回工作区相对路径，目录以 / 结尾。后续 read_file、get_file_outline 等工具应优先直接复用这里返回的完整路径。",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "要扫描的目录路径（相对于工作区根目录，或绝对路径）",
          },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "glob_search",
      description: "通过通配符搜索工作区文件列表（如 **/*.tsx）",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "glob 搜索模式，如 **/*.ts" },
        },
        required: ["pattern"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "grep_search",
      description: "仅在当前工作区内快速正则搜索文本，无需读取完整文件内容。不能搜索工作区外路径；已知的外部依赖文件请用 read_file 精确读取。",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "正则搜索表达式" },
          path: { type: "string", description: "工作区相对目录，默认为 .；禁止绝对路径和 .." },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "web_search",
      description: "在公共网络上搜索当前、外部或网页相关信息。仅在用户开启网络后可用；返回标题、URL、摘要和来源。回答必须引用返回的来源 URL。",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "搜索关键词或问题" },
          provider: { type: "string", description: "可选搜索源：duckduckgo、bing、baidu。默认 duckduckgo" },
          max_results: { type: "number", description: "最多返回多少条结果，默认 5，最多 8" },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "web_fetch",
      description: "读取指定 HTTP/HTTPS 网页正文。GitHub repo/blob/tree/raw 链接会优先走公开 GitHub API 或 raw 内容解析。仅在用户开启网络后可用；回答必须引用来源 URL。",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "要读取的 HTTP/HTTPS URL" },
          max_chars: { type: "number", description: "最多返回多少字符，默认 12000，最多 30000" },
        },
        required: ["url"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "repo_map_status",
      description: "检查 MAIN 内置代码图谱索引状态。返回索引文件数量、符号数量、导入/调用关系数量和是否需要刷新。开箱即用，不依赖外部 codegraph 命令。",
      parameters: {
        type: "object",
        properties: {},
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "repo_map_search",
      description: "在 MAIN 内置代码图谱中按符号名、签名、文件路径搜索。优先用于定位相关源码，返回路径、行号、符号类型和短签名，不返回大段源码。",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "符号、函数、组件、文件名或关键词" },
          kind: { type: "string", description: "可选，限制符号类型，如 function,class,interface,type,constant" },
          limit: { type: "number", description: "最多返回多少项，默认 12" },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "repo_map_context",
      description: "根据任务描述从 MAIN 内置代码图谱组装小型上下文包。返回相关文件、符号、行号、导入/调用关系摘要；不会读取完整源码。",
      parameters: {
        type: "object",
        properties: {
          task: { type: "string", description: "当前要理解或修改的问题描述" },
          max_nodes: { type: "number", description: "最多返回多少个相关节点，默认 16" },
        },
        required: ["task"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "repo_map_files",
      description: "从 MAIN 内置代码图谱返回项目文件结构摘要。适合替代大范围目录扫描，默认只返回源码/测试/配置文件路径和符号数量。",
      parameters: {
        type: "object",
        properties: {
          filter: { type: "string", description: "可选，按路径或扩展名过滤" },
          max_depth: { type: "number", description: "可选，最大目录深度" },
          limit: { type: "number", description: "最多返回多少个文件，默认 80" },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "repo_map_impact",
      description: "基于 MAIN 内置代码图谱估算修改某个符号或文件会影响哪些文件。返回导入者、被导入文件和相关测试候选。",
      parameters: {
        type: "object",
        properties: {
          target: { type: "string", description: "符号名或文件路径" },
          depth: { type: "number", description: "影响关系遍历深度，默认 2" },
        },
        required: ["target"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "code_ast_query",
      description: "使用 Tree-sitter 解析单个源码文件的真实语法树，返回有界的声明节点、符号名、语法节点类型、位置、签名和语法错误统计。支持 TS/TSX/JS/JSX/Rust/Python/C#/Go；需要理解结构时优先于整文件读取。",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "要解析的源码文件路径" },
          query: { type: "string", description: "可选，按符号名、签名或语法节点类型过滤" },
          kinds: { type: "string", description: "可选，逗号分隔的标准类型或语法节点类型，如 function,class,interface" },
          max_results: { type: "number", description: "最多返回多少个声明，默认 80，最大 200" },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "find_symbol_references",
      description: "使用 Tree-sitter 在指定文件或目录中查找符号的语法级定义、导入、调用和引用，忽略注释与字符串。适合修改前定位影响点；同名标识符可能属于不同语义符号，存在歧义时需结合 AST 上下文或编译器验证。",
      parameters: {
        type: "object",
        properties: {
          symbol: { type: "string", description: "要精确匹配的标识符名称" },
          path: { type: "string", description: "可选，限制到某个源码文件或目录；默认整个工作区" },
          max_results: { type: "number", description: "最多返回多少个位置，默认 80，最大 200" },
        },
        required: ["symbol"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_file",
      description: "读取源码、Markdown、JSON、日志、纯文本等文件的内容窗口。工作区外的本机绝对路径会先请求用户授权，授权后通过临时附件副本读取。大文件不会伪装成完整内容，会返回 truncated、totalLines、totalChars、returnedLines、nextStartLine 等元数据；需要后续内容时继续用 start_line/end_line/max_lines 读取指定行区间。若单行超过窗口，会返回 0-based、end-exclusive 的 returnedCharRange/nextStartChar；用 start_char 和 max_chars 继续同一版本，相邻结果可直接拼接。遇到 TypeScript/测试报错行号时，优先读取报错行附近窗口，不要全量读取大文件，也不要用 run_command 分段分页读文件。",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "文件路径" },
          start_line: {
            type: "number",
            description: "可选，1-based 起始行号。适合读取报错行附近或继续读取 nextStartLine。",
            runtimeIdentityDefault: 1,
          },
          end_line: { type: "number", description: "可选，1-based 结束行号。可与 start_line 搭配读取精确范围。" },
          max_lines: { type: "number", description: "可选，最多返回多少行。大文件默认只返回安全窗口；继续读取时通常传 nextStartLine 和 max_lines。" },
          start_char: { type: "number", description: "可选，0-based Unicode code-point 字符游标。仅用于 returnedCharRange/nextStartChar 续读；不要与行窗口参数混用。" },
          max_chars: { type: "number", description: "可选，字符窗口上限。与 start_char 配合可无损续读超长单行。" },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_document",
      description: "读取 PDF、DOCX、XLSX、CSV、TSV 等文档内容，并返回提取文本与来源元数据（如页码、sheet、单元格范围）。当 read_file 无法处理二进制/结构化文档时优先使用。",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "文档路径" },
          max_chars: { type: "number", description: "最多返回多少字符，默认约 6000" },
          max_blocks: { type: "number", description: "最多返回多少个结构化内容块，默认约 24" },
          row_offset: { type: "number", description: "对于 CSV/TSV/XLSX 等表格文档，可选：从第几行数据开始读取，默认 0" },
          max_rows: { type: "number", description: "对于 CSV/TSV/XLSX 等表格文档，可选：最多读取多少行数据窗口" },
          sheet: { type: "string", description: "对于 XLSX，可选：指定 sheet 名称" },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "analyze_tabular_document",
      description: "对 CSV、TSV、XLSX 等表格文件做全表统计分析，返回总行数、列概况、缺失值、数值列统计、类别列高频值以及头尾样本行。适合大型表格的整体理解，不必先把整张表读进上下文。",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "表格文件路径" },
          sheet: { type: "string", description: "对于 XLSX，可选：指定要分析的 sheet" },
          max_columns: { type: "number", description: "最多分析多少列，默认约 40" },
          sample_rows: { type: "number", description: "头部/尾部各保留多少样本行，默认约 5" },
          focus_columns: { type: "string", description: "可选，逗号分隔的列名，只分析这些列" },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "query_tabular_document",
      description: "对 CSV、TSV、XLSX 表格做结构化查询，可按条件筛选、选列、排序、分页、分组聚合。适合回答“有多少行符合条件”“按课程汇总金额”“取前 20 条异常记录”这类问题。",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "表格文件路径" },
          sheet: { type: "string", description: "对于 XLSX，可选：指定要查询的 sheet" },
          select_columns: { type: "string", description: "可选，逗号分隔的列名；聚合查询时也可填写分组列或聚合结果别名" },
          filters: { type: "string", description: "可选，JSON 数组字符串。每项形如 {\"column\":\"状态\",\"op\":\"=\",\"value\":\"completed\"}。支持 =, !=, >, >=, <, <=, in, not_in, contains, not_contains, starts_with, ends_with, is_empty, not_empty" },
          filter_logic: { type: "string", description: "多个 filters 的组合逻辑，and 或 or，默认 and" },
          group_by: { type: "string", description: "可选，逗号分隔的分组列名" },
          aggregations: { type: "string", description: "可选，JSON 数组字符串。每项形如 {\"op\":\"sum\",\"column\":\"金额\",\"as\":\"total_amount\"}。支持 count, sum, avg, mean, min, max, nunique" },
          sort_by: { type: "string", description: "可选，排序规则。可用 JSON 数组字符串 [{\"column\":\"金额\",\"direction\":\"desc\"}]，也可用简写 金额:desc,日期:asc" },
          row_offset: { type: "number", description: "可选，分页偏移量，默认 0" },
          limit: { type: "number", description: "可选，最多返回多少行结果，默认 50" },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "index_workspace_documents",
      description: "扫描指定目录中的文档文件并生成索引摘要，适合先了解工作区里有哪些 PDF、DOCX、XLSX、CSV、TSV、TXT、MD 等资料，再决定深入读取哪些文件。",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "要扫描的目录路径，默认当前工作区根目录" },
          max_files: { type: "number", description: "最多索引多少个文档，默认约 8" },
          max_chars_per_file: { type: "number", description: "每个文档返回多少预览字符，默认约 700" },
          extensions: { type: "string", description: "可选，逗号分隔的扩展名列表，如 pdf,docx,xlsx,csv" },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "knowledge_search",
      description: "在 MAIN 全局知识库中检索已启用的资料库，返回与问题最相关的片段和 citation（知识库、文件名、页码/块号、chunk id、分数）。涉及 Unity/API 手册等已导入资料时，先用它获取证据，不要把整份文档读入上下文。",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "用户问题或要检索的关键词/概念" },
          kb_ids: { type: "string", description: "可选，逗号分隔的知识库 ID；默认搜索当前界面启用的知识库" },
          limit: { type: "number", description: "最多返回多少个片段，默认 8，最多 16" },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "knowledge_get_excerpt",
      description: "根据 knowledge_search 返回的 source_id 与 chunk_id 读取某个知识库片段的完整摘录。只在需要展开已命中的 citation 时使用。",
      parameters: {
        type: "object",
        properties: {
          source_id: { type: "string", description: "knowledge_search citation.sourceId" },
          chunk_id: { type: "string", description: "knowledge_search citation.chunkId" },
        },
        required: ["source_id", "chunk_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "replace_in_file",
      description: "Replace one unique exact text block in an existing file and return a structured diff. Use the schema keys path, search_text, and replace_text exactly. Copy the smallest block that is still unique directly from current source; never reconstruct a large unchanged region from memory. search_text must match verbatim and occur only once.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "文件路径" },
          search_text: { type: "string", description: "直接从当前源码复制的最小唯一旧代码块（必须逐字匹配，不要包含无关的未修改函数）" },
          replace_text: { type: "string", description: "新代码" },
        },
        required: ["path", "search_text", "replace_text"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description: "完整写入文件内容（覆盖已有文件或创建新文件）。触发 UI 审查，展示 Diff 比对。",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "文件路径" },
          content: { type: "string", description: "完整的文件内容" },
        },
        required: ["path", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "apply_patch",
      description: "Apply a structured workspace patch and return changed paths plus diff evidence. Prefer Codex patch syntax with exactly one *** Begin Patch and one *** End Patch wrapper; put no stray patch markers outside that wrapper.",
      parameters: {
        type: "object",
        properties: {
          patch: { type: "string", description: "Complete patch text. Example: *** Begin Patch\n*** Update File: src/example.ts\n@@\n-old\n+new\n*** End Patch. A standard ---/+++ unified diff is also accepted." },
        },
        required: ["patch"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "delete_workspace_path",
      description: "Delete one exact workspace-relative file or empty path after explicit destructive-operation review. Never use the workspace root, an absolute path, `..`, a glob, or a broad directory. Prefer a narrower modification when deletion is not required by the approved solution.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Exact workspace-relative deletion target. The runtime revalidates scope and requests one-shot destructive approval before execution.",
          },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "git_status",
      description: "从 MAIN 原生 Git 后端读取结构化工作区状态，包括分支、上游、ahead/behind、staged/unstaged/untracked/conflicted 数量和增删行统计。只读且无需 Shell；检查改动状态时优先使用。",
      parameters: {
        type: "object",
        properties: {
          include_stats: { type: "boolean", description: "是否计算增删行统计，默认 true" },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "git_diff",
      description: "从 MAIN 原生 Git 后端读取 HEAD 到当前工作区的结构化差异，覆盖 staged、unstaged 和 untracked 文件，返回有界 unified hunks 与增删行统计。大仓库应传 path 或 filter 缩小范围；只读且无需 Shell。",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "可选，只返回指定工作区相对文件" },
          filter: { type: "string", description: "可选状态组：changed、added、deleted、untracked" },
          context_lines: { type: "number", description: "每个变更块保留的上下文行数，默认 3，最大 12" },
          max_files: { type: "number", description: "最多返回多少个文件，默认 20，最大 60" },
          max_chars: { type: "number", description: "所有 diff hunk 的总字符预算，默认 24000，最大 80000" },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "execute_command",
      description: "在集成 PTY shell 空闲时发送一条命令并短暂等待输出。适合启动开发服务器、交互式进程或需要保留终端上下文的命令；前台进程仍运行时会返回 PTY_BUSY，此时不得重发 shell 命令，应读取现有日志或用 send_pty_input 进行有意的交互。",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "要执行的 shell 命令" },
          description: { type: "string", description: "本次命令的简短目的说明。必须说明为什么要执行，供审批与审计显示。" },
          cwd: { type: "string", description: "工作区相对目录；工作区根目录用 `.`。不要使用绝对路径或 `..`。" },
          workdir: { type: "string", description: "cwd 的兼容别名；优先使用 cwd。" },
          wait_ms: { type: "number", description: "发送命令后等待多少毫秒再读取新增输出，默认 4000，最大 30000" },
          max_chars: { type: "number", description: "本次返回的新增终端输出最多多少字符，默认 8000" },
        },
        required: ["command", "description"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "send_pty_input",
      description: "向已有 PTY 前台进程发送原始输入。适合回答交互式提示或发送控制动作；Ctrl+C 优先传 control=interrupt，也兼容 input=CTRL_C。不会创建 PTY，也不会把输入解释为新的 shell 命令。",
      parameters: {
        type: "object",
        properties: {
          input: { type: "string", description: "要写入 PTY 的原始文本；Ctrl+C 可传 CTRL_C" },
          control: { type: "string", enum: ["interrupt"], description: "结构化控制动作；interrupt 表示单次 Ctrl+C" },
          append_newline: { type: "boolean", description: "普通文本输入后是否追加换行，默认 false；控制动作禁止追加换行" },
          wait_ms: { type: "number", description: "写入后等待多少毫秒再读取新增输出，默认 500" },
          max_chars: { type: "number", description: "本次返回的新增终端输出最多多少字符，默认 8000" },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "run_command",
      description: "同步执行一个有限时 shell 命令并等待结束，返回 stdout、stderr、exitCode、timedOut、durationMs。适合测试、构建和一次性诊断；比 execute_command 更适合需要明确成功/失败的步骤。文件修改回合不得用 Python、重定向、sed 或临时脚本写工作区源码，必须改用 apply_patch、replace_in_file 或 write_file 以保留结构化 diff 与 changedPaths。",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "要执行的 shell 命令" },
          description: { type: "string", description: "本次命令的简短目的说明。必须说明为什么要执行，供审批与审计显示。" },
          cwd: { type: "string", description: "工作区相对目录；工作区根目录用 `.`。不要使用绝对路径或 `..`。" },
          workdir: { type: "string", description: "cwd 的兼容别名；优先使用 cwd。" },
          timeout_ms: { type: "number", description: "超时时间毫秒，默认 60000，最大 600000" },
          input: { type: "string", description: "可选 stdin 输入" },
        },
        required: ["command", "description"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "browser_evaluate",
      description: "使用 Playwright 打开本地页面进行浏览器级验证，返回 DOM、console、网络失败、空白页诊断、断言、交互元素候选定位器和截图证据。确定性的 selector/验证规格错误会明确返回 validationSpecError；仅允许 localhost/127.0.0.1/[::1]/file://工作区内页面。",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "要打开的本地 URL，例如 http://localhost:5173 或工作区内 file:// 页面" },
          actions: { type: "string", description: "可选，逐行 Playwright 动作 DSL：click: selector；fill: selector => text；press: selector => Enter；select_file: selector => relative/file.csv；wait_for_selector: selector；wait_for_text: text（只检查 document.body 正文，不检查页面 title）。优先使用工具返回的 DOM/locator 事实，不要猜 selector。" },
          checks: { type: "string", description: "可选，逐行断言 DSL：text: 文本；not_text: 文本；selector: CSS；not_selector: CSS；title: 文本；console: 文本；not_console: 文本；no_console_errors。验证交互效果时至少提供一个动作前为假、动作后为真的可观察断言；页面初始就成立的断言不能证明点击/输入生效。" },
          wait_for_text: { type: "string", description: "可选，打开页面后等待 document.body 正文中出现的文本；不能用页面标题，标题请使用 checks: title: 文本" },
          wait_for_selector: { type: "string", description: "可选，打开页面后等待出现的 CSS selector" },
          screenshot: { type: "boolean", description: "可选，是否保存全页截图到 .MAIN/browser-validation/ 作为验证证据，默认 true；仅在明确不需要视觉证据时设为 false" },
          fail_on_console_error: { type: "boolean", description: "可选，console error/pageerror 是否让验证失败，默认 true" },
          timeout_ms: { type: "number", description: "可选，单次浏览器验证超时时间，默认 15000，最大 180000" },
        },
        required: ["url"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "computer_use",
      description: "在 macOS 上通过系统 Accessibility API 对真实桌面应用执行受限自动化，并返回结构化动作、断言、窗口/控件清单和可选窗口截图。该工具与浏览器验证分离且每次需要桌面控制审批；只接受固定动作 DSL，不执行模型提供的 AppleScript、shell 或任意坐标脚本。",
      parameters: {
        type: "object",
        properties: {
          app_name: { type: "string", description: "系统进程/应用显示名称，例如 MAIN 或 TextEdit。必须精确对应正在运行或要启动的应用。" },
          app_path: { type: "string", description: "可选，仅当 launch=true 时使用；必须是工作区内现有 .app 的相对路径。已安装应用按 app_name 启动时省略。" },
          launch: { type: "boolean", description: "可选，是否先启动应用，默认 false。开发态 Tauri 通常先用 execute_command 启动，再用本工具控制。" },
          activate: { type: "boolean", description: "可选，执行前是否将目标应用置于前台，默认 true。" },
          actions: { type: "string", description: "可选，逐行受限桌面动作 DSL：activate；inspect；click: 无障碍名称；fill: 无障碍名称 => 文本；press: Enter|Tab|Escape|Space|ArrowLeft|ArrowRight|ArrowUp|ArrowDown|Delete；wait_for: 可访问文本；wait: 毫秒；choose_file: 工作区相对文件。click/fill 使用 Accessibility 标签而非坐标。" },
          checks: { type: "string", description: "可选，逐行断言 DSL：text: 文本；not_text: 文本；window: 标题；not_window: 标题；role: AXRole；not_role: AXRole；dialog: visible|hidden。交互验收应使用动作前为假、动作后为真的断言（例如 dialog: visible），避免用初始已存在的文本充当因果证据。" },
          screenshot: { type: "boolean", description: "可选，是否截取目标应用首个窗口到 .MAIN/desktop-validation/，默认 false。截图会捕获真实桌面内容，应仅在验收确有需要时开启。" },
          timeout_ms: { type: "number", description: "可选，整次桌面控制调用的总时间预算，默认 15000，最大 120000；预算耗尽会返回结构化 timeout，不会由宿主强杀后丢失诊断。" },
        },
        required: ["app_name"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_pty_buffer",
      description: "读取当前 PTY 终端捕获缓冲区。兼容旧工具；如果只需要最近日志优先用 read_pty_tail，如果要读某次命令之后的新增内容优先用 read_pty_since。",
      parameters: {
        type: "object",
        properties: {
          max_chars: { type: "number", description: "最多返回多少字符；不传则返回当前缓冲区全部内容（可能被后端限制）" },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_pty_tail",
      description: "可选等待后读取 PTY 终端最近的 N 个字符，并返回偏移量信息，适合查看最新日志、错误栈和长命令的尾部输出。",
      parameters: {
        type: "object",
        properties: {
          max_chars: { type: "number", description: "最多读取最近多少字符，默认 8000" },
          wait_ms: { type: "number", description: "读取前等待多少毫秒，让运行中的命令继续产生日志，默认 0，最大 30000" },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_pty_since",
      description: "可选等待后读取 PTY 终端从指定 buffer offset 之后的新输出，返回 text、startOffset、endOffset、truncated 等信息。适合在 execute_command 前记录 offset，之后只检查新增日志。",
      parameters: {
        type: "object",
        properties: {
          offset: { type: "number", description: "从哪个 PTY buffer offset 开始读取" },
          max_chars: { type: "number", description: "最多返回多少字符，默认不截断" },
          wait_ms: { type: "number", description: "读取前等待多少毫秒，让运行中的命令继续产生日志，默认 0，最大 30000" },
        },
        required: ["offset"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_pty_status",
      description: "可选等待后检查集成 PTY 是否已启动、shell 是否可接受新命令、当前前台进程组/代次/三态所有权、捕获缓冲区 offset/字节数，以及最近少量输出。foregroundState=busy 表示前台进程占用，idle 表示 shell 空闲，unknown 表示平台不支持可靠识别。",
      parameters: {
        type: "object",
        properties: {
          wait_ms: { type: "number", description: "检查前等待多少毫秒，默认 0，最大 30000" },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_project_skeleton",
      description: "极速获取项目宏观目录树。支持 Unity 感知：自动识别 .asmdef 模块边界、折叠超过12个 .cs 文件的目录、弹性穿透无关键文件的层级。优先用于全局架构理解。",
      parameters: {
        type: "object",
        properties: {
          depth: {
            type: "number",
            description: "目录遍历最大深度（默认 4）",
          },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_file_outline",
      description: "提取 C# 文件的类型定义和 public/protected 成员签名（方法、属性），剔除函数体。用于在不读取完整源码的情况下快速理解类的接口和耦合关系。",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "C# 文件路径（相对于工作区根目录，或绝对路径）",
          },
        },
        required: ["path"],
      },
    },
  },
];

// ── Skill → Tool Schema conversion ──────────────────────────────────

/** Convert a skill name to a valid OpenAI function name (snake_case). */
export function skillNameToToolName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/_+/g, "_");
}

const DEFAULT_TOOL_PARAMETERS: ToolDefinition["function"]["parameters"] = {
  type: "object",
  properties: {
    input: { type: "string", description: "Input for this skill tool" },
  },
  required: [],
};

/**
 * Convert a tool-type Skill into an OpenAI ToolDefinition.
 * Returns null if the skill is not a tool-type or conversion fails.
 */
export function skillToToolDefinition(skill: Skill): ToolDefinition | null {
  if (skill.type !== "tool") return null;

  const toolName = skillNameToToolName(skill.name);
  if (!toolName) return null;

  let parameters = DEFAULT_TOOL_PARAMETERS;
  if (skill.toolParameters) {
    try {
      const parsed = JSON.parse(skill.toolParameters);
      if (parsed && typeof parsed === "object" && parsed.type === "object") {
        parameters = parsed;
      }
    } catch {
      // Invalid JSON — fall back to default
    }
  }

  return normalizeToolDefinition({
    type: "function",
    function: {
      name: toolName,
      description: skill.desc || skill.name,
      parameters,
    },
  });
}

/**
 * Convert an MCPTool (from MCP server discovery) into an OpenAI ToolDefinition.
 * MCP tools use `inputSchema` which follows JSON Schema — directly mappable
 * to OpenAI's `parameters` format.
 */
export function mcpToToolDefinition(tool: MCPTool): ToolDefinition | null {
  if (!tool.name) return null;

  const parameters = tool.inputSchema &&
    typeof tool.inputSchema === "object" &&
    tool.inputSchema.type === "object"
    ? {
        type: "object" as const,
        properties: (tool.inputSchema.properties ?? {}) as Record<
          string,
          { type: string; description?: string }
        >,
        required: (tool.inputSchema.required ?? []) as string[],
      }
    : {
        type: "object" as const,
        properties: {
          input: { type: "string", description: "Input for this tool" },
        },
        required: [] as string[],
      };

  return normalizeToolDefinition({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description || `MCP tool: ${tool.name}`,
      parameters,
    },
  });
}

/**
 * Build the merged tool definitions array: MCP tools (first) + built-in tools + active skill tools.
 * Placing MCP tools first ensures LLM tool callers prioritize MCP capabilities when active.
 */
export function buildToolDefinitions(skills: Skill[], mcpTools?: MCPTool[]): ToolDefinition[] {
  const skillTools = skills
    .filter((s) => s.active && s.type === "tool")
    .map(skillToToolDefinition)
    .filter((td): td is ToolDefinition => td !== null);

  const mcpToolDefs = (mcpTools ?? [])
    .map(mcpToToolDefinition)
    .filter((td): td is ToolDefinition => td !== null);

  return normalizeToolDefinitions([...mcpToolDefs, ...TOOL_DEFINITIONS, ...skillTools]);
}
