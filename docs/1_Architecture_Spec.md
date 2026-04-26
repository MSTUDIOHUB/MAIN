# MAIN — Architecture Specification

## 0. Project Overview

MAIN is a **Local-First AI Agent IDE** built with Tauri (Rust backend) + React/TypeScript (frontend). It provides an AI programming assistant with direct access to the local codebase, file system, and terminal. The system is optimized for local LLMs (8B-32B parameters) running via LM Studio, Ollama, or OMLX, while also supporting cloud OpenAI-compatible APIs.

**Core Differentiators:**
- **Human-in-the-Loop Safety**: Write operations require user approval through ActionCard with diff viewer
- **Plan Mode**: Spec-driven review-first workflow for complex tasks (Requirements → Design → Implementation)
- **Unity-Optimized**: `.asmdef` module boundary detection, C# file outline extraction, large directory folding
- **MCP Integration**: HTTP JSON-RPC tool discovery and execution from external servers
- **Thinking Model Support**: Handles `reasoning_content` from Qwen3.5/DeepSeek-R1 with garbled token detection
- **Self-Healing Agent Loop**: Context overflow auto-compaction, max_tokens escalation (4K→64K), repetition loop detection

## 1. Tech Stack

### Frontend
| Technology | Purpose |
|---|---|
| React 19 | UI framework |
| TypeScript | Type-safe development |
| Vite | Build tool + dev server |
| TailwindCSS v4 | Utility-first styling |
| Zustand | State management (with persistence middleware) |
| react-markdown + rehype/remark | Markdown rendering with GFM + syntax highlighting |
| @xterm/xterm | Terminal emulator (connected to Rust PTY) |
| @tauri-apps/api | Tauri IPC (invoke + listen) |

### Backend (Rust / Tauri 2)
| Crate | Purpose |
|---|---|
| `tauri` | Desktop app framework + IPC |
| `tokio` | Async runtime |
| `serde` + `serde_json` | Serialization |
| `portable-pty` | PTY integration for terminal |
| `regex` | Fast regex search (grep_search) |
| `walkdir` | Efficient directory traversal (get_project_skeleton) |
| `tiktoken-rs` | Token counting |
| `reqwest` | HTTP client (SSE proxy + MCP) |
| `zip` | Protocol package extraction |

## 2. Project Structure

```
MAIN/
├── index.html                  # Vite entry
├── package.json                # Dependencies
├── vite.config.ts              # Vite + Tauri plugin config
├── tsconfig.json               # TypeScript config
├── docs/                       # Documentation (this folder)
├── public/                     # Static assets
├── src/                        # Frontend source
│   ├── App.tsx                 # Root component
│   ├── main.tsx                # Entry point
│   ├── components/             # UI components (flat structure)
│   │   ├── ActionCard.tsx      # Write operation review card (Accept/Reject + Diff)
│   │   ├── ChatArea.tsx        # Main chat message area
│   │   ├── CollapsibleToolBlock.tsx  # Tool execution logs (collapsible)
│   │   ├── Composer.tsx        # Input with @-mentions + Stop button
│   │   ├── Icons.tsx           # SVG icon components
│   │   ├── JobListCard.tsx     # Task execution progress card
│   │   ├── MarkdownRenderer.tsx # Markdown → React with syntax highlighting
│   │   ├── PlanReviewBlock.tsx # Plan review with task checklist + progress bar
│   │   ├── RightPanel.tsx      # Diff Viewer + Terminal tabs
│   │   ├── SettingsModal.tsx   # Provider config, theme, language
│   │   ├── Sidebar.tsx         # Workspaces, sessions, settings
│   │   ├── SkillsModal.tsx     # Skills CRUD + protocol package import
│   │   ├── StreamingCursor.tsx # Animated cursor during LLM generation
│   │   ├── ThemeStyles.tsx     # CSS variable theme system
│   │   └── ThoughtBlock.tsx    # Collapsible thinking/analysis block
│   ├── lib/                    # Core logic (flat structure)
│   │   ├── contextTrim.ts     # Middle-out trimming + tool result compaction
│   │   ├── ipc.ts             # Tauri IPC wrappers (typed)
│   │   ├── mcpClient.ts       # MCP HTTP client (JSON-RPC 2.0)
│   │   ├── messageParser.ts   # Stream message parsing
│   │   ├── modelDiscovery.ts  # Auto-detect local models
│   │   ├── orchestrator.ts    # Agent execution loop
│   │   ├── sanitize.ts        # Output sanitization
│   │   ├── streaming.ts       # SSE streaming (multi-provider)
│   │   ├── systemPrompt.ts    # System prompt assembly
│   │   ├── textToolParser.ts  # XML/JSON tool call parser
│   │   ├── toolExecutor.ts    # Tool routing (IPC + MCP)
│   │   ├── toolSchemas.ts     # OpenAI-format tool definitions
│   │   └── utils.ts           # Shared utilities
│   └── store/
│       └── useAppStore.ts     # Zustand store (state + actions)
├── src-tauri/                  # Rust backend
│   ├── src/
│   │   └── lib.rs             # All Tauri commands (1000+ lines)
│   ├── Cargo.toml
│   └── tauri.conf.json
├── .MAIN/                      # Project metadata (hidden)
│   ├── plans/                  # Spec files (auto-created, user-deleted)
│   └── steering/               # Project conventions (optional)
└── dist/                       # Build output
```

## 3. Architecture Diagrams

### Request Flow
```
User Input → Composer → useAppStore.sendMessage()
                              ↓
                     orchestrator.executeAgentLoop()
                              ↓
                 ┌──── buildSystemPrompt() ────┐
                 │  workspace + persona +      │
                 │  skills + workflow mode     │
                 └────────────────────────────┘
                              ↓
                 ┌──── manageContext() ────────┐
                 │  compact tool results       │
                 │  middle-out trim           │
                 └────────────────────────────┘
                              ↓
                 ┌──── streamChatCompletion() ┐
                 │  SSE via fetch or Rust proxy│
                 │  onToken → UI streaming     │
                 │  onDone → tool call parsing │
                 └────────────────────────────┘
                              ↓
                    Tool calls found?
                   ╱                ╲
                 Yes                 No
                  ↓                  ↓
         ┌─ Read-only? ─┐    Plan Mode + <plan>?
         ╱              ╲    ╱               ╲
       Yes              No  Yes               No
        ↓                ↓   ↓                 ↓
   Auto-execute    requestReview()  waitForPlanApproval  → idle
   (concurrent)    (ActionCard)     (PlanReviewBlock)
        ↓                ↓           ↓ (approved)
   tool result     user decision   preserved plan files
        ↓                ↓           ↓
        └────── appendMessage() ──────┘
                      ↓
              Loop continues
```

### Multi-Provider Streaming
```
Frontend (streaming.ts)
├── Local (localhost) → direct fetch() → SSE parsing
└── Cloud/LAN → invoke("start_chat_stream") → Rust proxy → SSE via Tauri events
    ├── chat-stream-chunk → processSSEChunk()
    └── chat-stream-done → resolve result

Provider Detection:
├── Ollama → /api/chat (native format, no tools param)
└── Others → /v1/chat/completions (OpenAI format, tools param)
```

## 4. Key Technical Decisions

| Decision | Rationale |
|---|---|
| **Hermes XML prompt control** | Strict `<tool_use>` / `<parameter>` tags prevent JSON parsing failures with local LLMs |
| **Dual tool call parsing** | Native `tool_calls` (API) preferred; XML text parser as fallback for models without function calling |
| **Rust backend for file/grep** | `std::fs` + `regex` crate far outperform JavaScript file operations |
| **Workspace-scoped path safety** | All file ops validated via `ensure_in_workspace()` in Rust — prevents path traversal |
| **Error feedback pattern** | Tool errors returned as `role: "tool"` messages (not thrown) — AI sees error and self-corrects |
| **Atomic tool result pairing** | Tool results kept with parent assistant messages during trimming — prevents infinite retry |
| **Rust SSE proxy** | WebView CORS blocks cloud API calls; Rust proxy bypasses this with full HTTP client |
| **Context budget 75/25** | Reserve 25% of context window for output, 75% for input — prevents overflow |
| **Module-level MCP routing** | `toolServerMap` avoids threading through all function signatures for MCP tool lookup |
| **StreamingThinkingInterceptor** | Routes `<analysis>` / `<thinking>` tags to hidden ThoughtBlock — keeps chat clean |
