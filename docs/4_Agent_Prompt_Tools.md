# MAIN — Agent Prompting Engine & Tool Schemas

## 1. System Prompt Architecture

The system prompt is dynamically assembled by `buildSystemPrompt()` in `src/lib/systemPrompt.ts` from multiple layers:

```
┌─────────────────────────────────────┐
│ 1. Workspace Context                │
│    - Absolute workspace path        │
│    - Workspace directory tree       │
├─────────────────────────────────────┤
│ 2. Core Directives                  │
│    - Proactive tool use             │
│    - No hallucination               │
│    - Output visibility rules        │
│    - Analysis depth requirements    │
├─────────────────────────────────────┤
│ 3. Persona (optional)               │
│    - Architect / UI Designer /      │
│      Debugger                       │
├─────────────────────────────────────┤
│ 4. Workflow Mode                    │
│    - EDIT MODE: Direct execution    │
│    - PLAN MODE: Review-first        │
├─────────────────────────────────────┤
│ 5. Tool Format & Descriptions       │
│    - XML <tool_use> format          │
│    - Intent classification          │
│    - Spec-Driven protocol           │
│    - Steering discovery             │
│    - Strict formatting rules        │
├─────────────────────────────────────┤
│ 6. Active Workflow Skills           │
│    - Instruction skills (prompt)     │
│    - Protocol packages (on-disk)     │
└─────────────────────────────────────┘
```

## 2. Core Directives

The system prompt enforces these core rules:

1. **Proactive Tool Use** — Must actively call tools to gather information; never ask the user to manually paste code
2. **No Hallucination** — Must read files before modifying; never guess file contents or paths
3. **Direct Action** — Investigate and execute immediately; never ask "Should I..."
4. **Execution Verification** — Prefer `run_command` for finite commands with stdout/stderr/exitCode; after `execute_command`, verify with `read_pty_since`, `read_pty_tail`, or `get_pty_status`
5. **Workflow Priority** — If active workflow skills exist, they override general rules

### Output Visibility Rules (Critical)
- `<analysis>`, `<thought>`, `<thinking>`, `<reasoning>` tag content is **hidden** from users (routed to collapsed ThoughtBlock)
- All user-visible content (analysis, conclusions, proposals) must be **regular Markdown text**
- `<analysis>` is limited to 1-2 sentence internal notes before tool calls only
- This prevents the AI from putting its entire response inside hidden tags

### Analysis Depth Requirements
- `get_project_skeleton` only returns directory structure — **insufficient** for code analysis
- Must use `get_file_outline` or `read_file` to read actual code before giving analysis
- Analysis based solely on folder names has zero value

## 3. Tool Call Format

Tools are called using XML format (Hermes-style) for compatibility with local LLMs:

```xml
<analysis>我需要先检查 Scripts 目录的结构</analysis>

<tool_use>
<tool>list_directory</tool>
<parameter name="path">Assets/Scripts</parameter>
</tool_use>
```

When the model supports **native function calling** (OpenAI `tools` parameter), tool calls are sent via the API's `tool_calls` field instead. The orchestrator tries native format first, then falls back to XML text parsing.

## 4. Built-in Tool Definitions

| Tool | Type | Auto-Execute | Description |
|---|---|---|---|
| `list_directory` | Read | ✅ | Scan directory contents |
| `read_file` | Read | ✅ | Read complete file content |
| `read_document` | Read | ✅ | Extract PDF/DOCX/XLSX/CSV/TSV content |
| `analyze_tabular_document` | Read | ✅ | Summarize large tabular documents |
| `query_tabular_document` | Read | ✅ | Query/filter/aggregate tabular documents |
| `index_workspace_documents` | Read | ✅ | Index workspace documents |
| `glob_search` | Read | ✅ | Pattern-based file search (`**/*.ts`) |
| `grep_search` | Read | ✅ | Regex search within files |
| `get_project_skeleton` | Read | ✅ | Fast project directory tree (Unity-aware) |
| `get_file_outline` | Read | ✅ | C# type/member signature extraction |
| `read_pty_buffer` | Read | ✅ | Compatibility terminal buffer read |
| `read_pty_tail` | Read | ✅ | Read recent terminal logs |
| `read_pty_since` | Read | ✅ | Read terminal logs since an offset |
| `get_pty_status` | Read | ✅ | Check PTY process and buffer status |
| `clear_pty_buffer` | Buffer | ✅ | Reset AI-side terminal capture buffer |
| `write_file` | Write | ❌ | Full file write (triggers ActionCard review) |
| `replace_in_file` | Write | ❌ | Partial file replacement (triggers ActionCard review) |
| `run_command` | Execute | ❌ | Run finite shell command and return stdout/stderr/exitCode |
| `execute_command` | Execute | ❌ | Send command to PTY for interactive/long-running work |
| `send_pty_input` | Execute | ❌ | Send raw input to the PTY foreground process |

### Tool Schemas (OpenAI format)

```json
[
  {
    "name": "list_directory",
    "description": "扫描指定目录下的文件和子目录列表。返回相对路径，目录以 / 结尾。",
    "parameters": { "type": "object", "properties": { "path": { "type": "string", "description": "目录路径" } }, "required": ["path"] }
  },
  {
    "name": "glob_search",
    "description": "通过通配符搜索工作区文件列表（如 **/*.tsx）",
    "parameters": { "type": "object", "properties": { "pattern": { "type": "string", "description": "glob 搜索模式" } }, "required": ["pattern"] }
  },
  {
    "name": "grep_search",
    "description": "在特定目录快速正则搜索文本，无需读取完整文件内容。",
    "parameters": { "type": "object", "properties": { "query": { "type": "string", "description": "正则表达式" }, "path": { "type": "string", "description": "搜索目录，默认为 ." } }, "required": ["query"] }
  },
  {
    "name": "read_file",
    "description": "读取文件完整内容",
    "parameters": { "type": "object", "properties": { "path": { "type": "string", "description": "文件路径" } }, "required": ["path"] }
  },
  {
    "name": "replace_in_file",
    "description": "局部修改文件。精确替换旧代码块。触发 UI 审查。",
    "parameters": { "type": "object", "properties": { "path": { "type": "string" }, "search_text": { "type": "string", "description": "旧代码" }, "replace_text": { "type": "string", "description": "新代码" } }, "required": ["path", "search_text", "replace_text"] }
  },
  {
    "name": "write_file",
    "description": "完整写入文件内容（覆盖或创建）。触发 UI 审查，展示 Diff 比对。",
    "parameters": { "type": "object", "properties": { "path": { "type": "string" }, "content": { "type": "string", "description": "完整文件内容" } }, "required": ["path", "content"] }
  },
  {
    "name": "execute_command",
    "description": "向集成 PTY 发送命令，适合交互式或长驻命令。",
    "parameters": { "type": "object", "properties": { "command": { "type": "string", "description": "Shell 命令" }, "wait_ms": { "type": "number" }, "max_chars": { "type": "number" } }, "required": ["command"] }
  },
  {
    "name": "run_command",
    "description": "同步执行一次性 shell 命令并返回 stdout/stderr/exitCode。",
    "parameters": { "type": "object", "properties": { "command": { "type": "string" }, "timeout_ms": { "type": "number" }, "input": { "type": "string" } }, "required": ["command"] }
  },
  {
    "name": "send_pty_input",
    "description": "向当前 PTY 前台进程发送原始输入。",
    "parameters": { "type": "object", "properties": { "input": { "type": "string" }, "append_newline": { "type": "boolean" }, "wait_ms": { "type": "number" }, "max_chars": { "type": "number" } }, "required": ["input"] }
  },
  {
    "name": "read_pty_buffer",
    "description": "兼容读取终端缓冲区。",
    "parameters": { "type": "object", "properties": { "max_chars": { "type": "number" } }, "required": [] }
  },
  {
    "name": "read_pty_tail",
    "description": "读取终端尾部日志并返回 offset 元数据。",
    "parameters": { "type": "object", "properties": { "max_chars": { "type": "number" } }, "required": [] }
  },
  {
    "name": "read_pty_since",
    "description": "读取指定 PTY buffer offset 之后的新增输出。",
    "parameters": { "type": "object", "properties": { "offset": { "type": "number" }, "max_chars": { "type": "number" } }, "required": ["offset"] }
  },
  {
    "name": "get_pty_status",
    "description": "检查 PTY 运行状态、buffer offset 和最近输出。",
    "parameters": { "type": "object", "properties": {}, "required": [] }
  },
  {
    "name": "clear_pty_buffer",
    "description": "清空 AI 侧 PTY 捕获缓冲。",
    "parameters": { "type": "object", "properties": {}, "required": [] }
  },
  {
    "name": "get_project_skeleton",
    "description": "极速获取项目宏观目录树。Unity 感知：自动识别 .asmdef 模块边界、折叠超过12个 .cs 文件的目录。",
    "parameters": { "type": "object", "properties": { "depth": { "type": "number", "description": "最大深度（默认 4）" } }, "required": [] }
  },
  {
    "name": "get_file_outline",
    "description": "提取 C# 文件的类型定义和 public/protected 成员签名，剔除函数体。",
    "parameters": { "type": "object", "properties": { "path": { "type": "string", "description": "C# 文件路径" } }, "required": ["path"] }
  }
]
```

## 5. Extended Tool Sources

### 5.1 Skill-Based Tools
Custom tools defined by users in SkillsModal:
- User provides tool name, description, and JSON Schema parameters
- Converted via `skillToToolDefinition()` to OpenAI format
- Executed via `invoke("execute_skill", { name, args })` in Rust backend

### 5.2 MCP Tools
Dynamically discovered from MCP servers via HTTP JSON-RPC `tools/list`:
- Server URLs configured in settings
- Tools discovered at agent loop start via `discoverAllMcpTools()`
- Converted via `mcpToToolDefinition()` to OpenAI format
- Executed via `executeMcpTool()` — HTTP JSON-RPC `tools/call`
- Module-level `toolServerMap` for zero-signature-change routing

## 6. Workflow Modes

### 6.1 EDIT MODE (Direct Execution)
- Write operations execute after user approval via ActionCard
- No plan review step — agent proceeds directly
- Best for: simple fixes, targeted changes, experienced users

### 6.2 PLAN MODE (Review-First)
Plan Mode gates **writes**, not reads. It does NOT mean the AI must always produce spec files. Behavior adapts to task complexity:

| Tier | Trigger | Behavior |
|---|---|---|
| 🟢 **Simple** | Analysis, summaries, bug fixes, single-line changes | Direct answer. No `<plan>` tag, no spec files. |
| 🟡 **Medium** | 1-2 file changes, small features | Brief plan in Markdown + `<plan>` tag. Wait for approval. |
| 🔴 **Complex** | Multi-module, architectural changes, ≥2 files | Full Spec-Driven protocol: `requirements.md` → `design.md` → `tasks.md`. |

**Plan Mode Rules:**
1. Read-only tools → free to execute (no approval needed)
2. Write operations → must wait for user "Start Execution" click
3. Spec files in `.MAIN/plans/` → auto-created without approval, auto-deleted after execution
4. Source code must NEVER be written to `.MAIN/plans/`

## 7. Spec-Driven Three-Stage Protocol

For Architectural (🔴 complex) tasks in Plan Mode:

### Stage 1: `[STAGE: REQUIREMENTS]`
- Output: `.MAIN/plans/requirements.md`
- Format: **EARS notation** (Easy Approach to Requirements Syntax)
  ```
  WHEN [condition/event]
  THE SYSTEM SHALL [expected behavior]
  ```
- Includes: user stories, EARS requirements, acceptance criteria

### Stage 2: `[STAGE: DESIGN]`
- Output: `.MAIN/plans/design.md`
- Uses: `get_project_skeleton` (global structure) → `get_file_outline` (class interfaces) → `read_file` (implementation details)
- Includes: component architecture, Mermaid diagrams, design decisions with rationale, best practice annotations

### Stage 3: `[STAGE: IMPLEMENTATION]`
- Output: `.MAIN/plans/tasks.md`
- Format: `- [ ] Task description → REQ-XX` (checkbox tasks mapped to requirements)
- Execution: Only after DESIGN stage completion and user approval

### Bugfix Spec (Non-atomic bugs)
- Output: `.MAIN/plans/bugfix.md`
- Includes: current behavior, expected behavior, invariant behavior, root cause analysis, minimal fix with regression risk

## 8. Intent Classification

After receiving a task, the AI declares its classification in the response text:

```
任务分类：Atomic / Architectural
```

- **Atomic** (≤1 file, no architectural impact, unambiguous): Skip design artifacts, implement directly
- **Architectural** (≥2 files, architectural impact, ambiguous requirements): Must produce spec three-piece set

## 9. AI Personas

Switchable via Sidebar → Persona selector:

| Persona | Focus | Special Behaviors |
|---|---|---|
| **Architect** | Modular design, intent inference, spec-driven | Follows Spec-Driven protocol, `.asmdef` module boundaries, intent inference |
| **UI Designer** | Interface/UX optimization, responsive layout | Component reuse, animation transitions, accessibility |
| **Debugger** | Bug localization, performance analysis | Root cause analysis, log reading, regression prevention |

## 10. Steering Discovery

Before any implementation, the AI must check for project conventions:
1. `list_directory(".MAIN/steering/")` — check if steering directory exists
2. Read **base files** (always loaded): `product.md`, `tech.md`, `structure.md`, `project_conventions.md`
3. Read **domain files** (conditionally loaded): Based on `inclusion: fileMatch` or `inclusion: auto`
4. Steering rules **override** general guidelines (project-level conventions take priority)
