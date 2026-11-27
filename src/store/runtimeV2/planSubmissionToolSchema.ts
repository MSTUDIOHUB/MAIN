import type { ToolDefinition } from "../../lib/toolSchemas";

export const SUBMIT_WORK_PLAN_TOOL_NAME = "submit_runtime_v2_work_plan";

export const SUBMIT_WORK_PLAN_TOOL: ToolDefinition = {
  type: "function",
  function: {
    name: SUBMIT_WORK_PLAN_TOOL_NAME,
    description:
      "提交可审阅的实现计划。必须提供 Markdown 方案说明（planMarkdown）、文件变更步骤（changes）及验证方式（validations）。主动核实可用的构建、测试或交互检查，将能判定通过或失败的检查写入 validations。请为每个步骤在 dependsOn 中显式声明前置依赖（省略 dependsOn 表示 [] 无依赖，运行时不会自动推断；共享接口/基类、消费模块与服务组装入口之间的依赖关系必须明确列出）。仅准则映射在省略时由运行时补充；不要编造命令。",
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
                description: "可选，前置步骤的 0-based 索引列表；省略表示 []（无前置依赖），运行时不会自动推断。当存在共享接口、基类或总装注册入口时，消费模块和总装步必须显式依赖定义它们的前置步骤。",
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
