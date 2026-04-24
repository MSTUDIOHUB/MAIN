# MAIN — UI / UX Specification

## 1. Layout Architecture

Three-column IDE layout with True Black theme (`#09090b` background):

```
┌──────────────────────────────────────────────────────────────┐
│ Sidebar    │ Chat Flow Panel        │ Right Panel           │
│ (260px)    │ (flex: 1)              │ (Resizable 300-800px) │
│            │                        │                       │
│ Workspaces │ Segmented Toolbar      │ [Diff Viewer]         │
│ Sessions   │ Messages & Logs        │ [Terminal]             │
│ Settings   │ ActionCards            │                       │
│ Skills     │ PlanReviewBlock        │                       │
│            │ Docked Composer        │                       │
└──────────────────────────────────────────────────────────────┘
```

## 2. Theme System

**True Black IDE** with 5 selectable accent colors:

| Color | Hex | Name |
|---|---|---|
| VS Code Blue | `#0078d4` | Default |
| Amethyst | `#8b5cf6` | Purple |
| Matrix Green | `#22c55e` | Green |
| Sublime Gold | `#eab308` | Gold |
| Ruby Red | `#ef4444` | Red |

CSS variables managed in `ThemeStyles.tsx`, applied via `data-theme` attribute. All colors defined as HSL for consistent opacity variants.

## 3. Chat Flow Components

### 3.1 ChatArea (ChatArea.tsx)
Main message rendering area. Displays conversation turns as blocks:
- **User messages** — Right-aligned, accent-colored
- **Assistant messages** — Left-aligned, rendered via MarkdownRenderer
- **Thought blocks** — Auto-collapsed, muted gray
- **Tool blocks** — Collapsible execution logs
- **Action cards** — Floating review cards for write operations
- **Plan review block** — Full plan proposal with task checklist

**Streaming**: Real-time token rendering with `StreamingCursor` animation. Auto-scroll with manual scroll-up pause detection.

### 3.2 ThoughtBlock (ThoughtBlock.tsx)
Collapsible block for AI's internal reasoning (`<analysis>`, `<thinking>` tags):
- **Default state**: Collapsed — shows `💭 AI is thinking...` with muted styling
- **Expanded**: Shows full thinking content
- Content is **hidden from the user by default** — the `<analysis>` interceptor routes these tags to ThoughtBlock

### 3.3 CollapsibleToolBlock (CollapsibleToolBlock.tsx)
Collapsible execution log for each tool call:
- **Header**: Tool icon + tool name + target path/command
- **Status indicators**: ⏳ Running → ✅ Done / ❌ Error
- **Body**: Expandable to show full tool result (truncated at 8000 chars)
- Multiple tool calls from the same turn are stacked vertically

### 3.4 ActionCard (ActionCard.tsx)
**Human-in-the-loop** review card for write operations (`replace_in_file`, `write_file`):
- **Layout**: Floating card with file path header
- **Diff preview**: Opens in Right Panel Diff Viewer
- **Buttons**: `Reject` (red, aborts) / `Accept` (green, executes)
- **Auto-scroll**: Chat pauses scrolling when ActionCard is visible
- Only appears for write/execute tools — read-only tools auto-execute without review

### 3.5 PlanReviewBlock (PlanReviewBlock.tsx)
**Plan Mode** review container with task tracking:
- **Proposal content**: Markdown-rendered plan from AI
- **Task checklist**: Extracts `- [ ]` / `- [x]` checkbox lines → renders as dedicated task list
- **Progress bar**: Visual completion percentage (completed tasks / total tasks)
- **Buttons**: `Reject` (discard plan) / `Start Execution` (approve and begin)
- Only appears when `workflowMode === "plan"` and AI outputs `<plan>` tag
- **Anti-re-appear guard**: Won't show again after approval (`isPlanApproved` flag)

**Task Checklist Extraction Logic**:
1. Parse plan content for `- [ ]` and `- [x]` checkbox lines
2. Render as styled checkboxes with completion tracking
3. Strip checkbox lines from markdown body to avoid duplication
4. Show progress bar at top (e.g., "3/7 tasks completed")

## 4. Composer (Composer.tsx)

Multi-line input bar docked at the bottom of the Chat Flow:

| Feature | Behavior |
|---|---|
| `@` mentions | Attach files to message (file picker) |
| Send button | Sends message → starts agent loop |
| Stop button | Replaces Send when agent is running — aborts SSE stream |
| Multi-line | Shift+Enter for newline, Enter to send |
| Disabled state | Input disabled while agent is running |

## 5. Right Panel (RightPanel.tsx)

Resizable panel (300-800px) with two tabs:

### 5.1 Diff Viewer
- **Side-by-side**: Red background for removed lines, green for added
- **Triggered by**: ActionCard "View Diff" button
- **Format**: Standard unified diff with line numbers

### 5.2 Terminal
- **Engine**: xterm.js connected to Rust PTY
- **Features**: Full terminal emulation, real-time output via `pty-data` events
- **Agent access**: AI can run finite commands via `run_command`, drive interactive/long-running commands via `execute_command` / `send_pty_input`, and inspect logs through `read_pty_since`, `read_pty_tail`, `get_pty_status`, or compatibility `read_pty_buffer`

## 6. Sidebar (Sidebar.tsx)

Fixed 260px left panel with three sections:

| Section | Content |
|---|---|
| **Workspaces** | List of configured workspace paths |
| **Conversations** | Session list with auto-generated titles |
| **Settings** | Opens SettingsModal |

Workflow mode toggle (Edit Mode / Plan Mode) placed in sidebar header.

## 7. Modals

### 7.1 SettingsModal (SettingsModal.tsx)
- **Local Provider**: LM Studio / Ollama / OMLX endpoint, model name, API key
- **Cloud Provider**: OpenAI-compatible endpoint, model, API key, temperature, top_p
- **Context Limit**: Slider (2K-128K tokens) — controls context window budget
- **Theme**: 5 accent colors
- **Language**: English / Chinese (i18n)

### 7.2 SkillsModal (SkillsModal.tsx)
- **Skills List**: All configured skills with active/inactive toggles
- **Skill Types**: Instruction (prompt fragment), Tool (custom function), Package (protocol ZIP)
- **CRUD**: Add, edit, delete skills
- **Protocol Import**: Drag-drop ZIP file → extracted to `.protocols/<slot>/`
- **Persona Selection**: Switch between Architect / UI Designer / Debugger

## 8. Internationalization

Full i18n support for English and Chinese:
- UI labels and placeholders translated
- AI system prompt primarily in Chinese (for local Chinese models like Qwen)
- Settings modal language toggle
