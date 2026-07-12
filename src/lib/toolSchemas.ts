// lib/toolSchemas.ts
// Tool definitions in OpenAI-compatible format for native function calling.
// This is what Ollama / LM Studio / OpenAI expect in the `tools` parameter.
// ────────────────────────────────────────────────────────────────────

import type { Skill } from "./appTypes";
import type { MCPTool } from "./mcpClient";

export interface ToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: {
      type: "object";
      properties: Record<string, { type: string; description?: string }>;
      required: string[];
    };
  };
}

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

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    type: "function",
    function: {
      name: "spawn_subagent",
      description: "异步创建一个隔离的只读子智能体来处理有界、可独立完成的探索或分析任务。立即返回运行句柄；主体应继续处理不重叠工作，之后用 wait_subagents 汇合。",
      parameters: {
        type: "object",
        properties: {
          objective: { type: "string", description: "子智能体要独立完成的明确目标" },
          name: { type: "string", description: "可选显示名称，如 Euler；省略时由 MAIN 自动命名" },
          role: { type: "string", description: "可选角色，如 explorer、reviewer、tester、docs" },
          scope_key: { type: "string", description: "稳定、简短且唯一的职责范围标识" },
          scope: { type: "string", description: "该子智能体独占的职责边界，不得与主体当前探索重复" },
          context_hints: { type: "string", description: "可选的紧凑上下文提示，不要复制整段主对话" },
          allowed_paths: { type: "string", description: "允许读取和搜索的工作区路径，使用逗号分隔；本地任务最多 6 个" },
          expected_output: { type: "string", description: "汇合时需要返回的证据结构或判断" },
        },
        required: ["objective", "scope_key", "scope", "allowed_paths", "expected_output"],
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
      description: "在特定目录快速正则搜索文本，无需读取完整文件内容。",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "正则搜索表达式" },
          path: { type: "string", description: "要搜索的目录，默认为 ." },
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
      name: "read_file",
      description: "读取源码、Markdown、JSON、日志、纯文本等文件的内容窗口。工作区外的本机绝对路径会先请求用户授权，授权后通过临时附件副本读取。大文件不会伪装成完整内容，会返回 truncated、totalLines、totalChars、returnedLines、nextStartLine 等元数据；需要后续内容时继续用 start_line/end_line/max_lines 读取指定行区间。遇到 TypeScript/测试报错行号时，优先读取报错行附近窗口，不要全量读取大文件，也不要用 run_command 分段分页读文件。",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "文件路径" },
          start_line: { type: "number", description: "可选，1-based 起始行号。适合读取报错行附近或继续读取 nextStartLine。" },
          end_line: { type: "number", description: "可选，1-based 结束行号。可与 start_line 搭配读取精确范围。" },
          max_lines: { type: "number", description: "可选，最多返回多少行。大文件默认只返回安全窗口；继续读取时通常传 nextStartLine 和 max_lines。" },
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
      description: "局部修改文件。精确替换旧代码块。触发 UI 审查。",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "文件路径" },
          search_text: { type: "string", description: "旧代码（必须与原文完全一致）" },
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
      description: "使用 Codex 风格补丁修改工作区文件，也兼容常见 ---/+++ unified diff。适合多处精确编辑，比 replace_in_file 更稳；触发 UI 审查并展示 diff。",
      parameters: {
        type: "object",
        properties: {
          patch: { type: "string", description: "补丁文本，优先使用 *** Begin Patch / *** End Patch；也可使用 --- a/file +++ b/file 的 unified diff" },
        },
        required: ["patch"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "execute_command",
      description: "在集成 PTY 终端发送一条命令并短暂等待输出。适合启动开发服务器、交互式进程或需要保留终端上下文的命令；执行后应继续用 read_pty_since / read_pty_tail / get_pty_status 检查日志。",
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
      description: "向当前 PTY 前台进程发送原始输入。适合回答交互式提示、输入 y/n、发送 Ctrl+C（input 使用 \\u0003）等，不会额外解释为新的 shell 命令。",
      parameters: {
        type: "object",
        properties: {
          input: { type: "string", description: "要写入 PTY 的原始文本" },
          append_newline: { type: "boolean", description: "是否在输入后追加换行，默认 false" },
          wait_ms: { type: "number", description: "写入后等待多少毫秒再读取新增输出，默认 500" },
          max_chars: { type: "number", description: "本次返回的新增终端输出最多多少字符，默认 8000" },
        },
        required: ["input"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "run_command",
      description: "同步执行一个 shell 命令并等待结束，返回 stdout、stderr、exitCode、timedOut、durationMs。适合运行测试、构建、Python 脚本、一次性检查命令；比 execute_command 更适合需要明确成功/失败的步骤。",
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
      description: "使用 Playwright 打开本地页面进行浏览器级验证，返回 DOM、console、网络失败、断言和可选截图证据。仅允许 localhost/127.0.0.1/[::1]/file://工作区内页面；用于计划执行阶段验证真实渲染，不能用 curl/grep/cat 替代。",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "要打开的本地 URL，例如 http://localhost:5173 或工作区内 file:// 页面" },
          actions: { type: "string", description: "可选，逐行 Playwright 动作 DSL：click: selector；fill: selector => text；press: selector => Enter；select_file: selector => relative/file.csv；wait_for_selector: selector；wait_for_text: text" },
          checks: { type: "string", description: "可选，逐行断言 DSL：text: 文本；not_text: 文本；selector: CSS；not_selector: CSS；title: 文本；console: 文本；not_console: 文本；no_console_errors" },
          wait_for_text: { type: "string", description: "可选，打开页面后等待正文中出现的文本" },
          wait_for_selector: { type: "string", description: "可选，打开页面后等待出现的 CSS selector" },
          screenshot: { type: "boolean", description: "可选，是否保存全页截图到 .MAIN/browser-validation/ 作为验证证据" },
          fail_on_console_error: { type: "boolean", description: "可选，console error/pageerror 是否让验证失败，默认 true" },
          timeout_ms: { type: "number", description: "可选，单次浏览器验证超时时间，默认 60000，最大 180000" },
        },
        required: ["url"],
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
      description: "可选等待后检查集成 PTY 是否已启动、shell 是否仍在运行、当前捕获缓冲区 offset/字节数，以及最近少量输出。",
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
      name: "clear_pty_buffer",
      description: "清空 AI 侧捕获的 PTY 输出缓冲区并重置读取起点。适合在启动长日志任务前标记干净起点；不会关闭终端进程。",
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
