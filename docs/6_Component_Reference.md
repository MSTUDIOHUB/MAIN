# MAIN — Component Reference

## File Index

| File | Lines | Purpose |
|---|---|---|
| `src/components/ActionCard.tsx` | — | Write operation review card |
| `src/components/ChatArea.tsx` | ~339 | Main chat message area |
| `src/components/CollapsibleToolBlock.tsx` | — | Tool execution log |
| `src/components/Composer.tsx` | — | Input bar with @-mentions |
| `src/components/Icons.tsx` | — | SVG icon components |
| `src/components/JobListCard.tsx` | — | Task progress card |
| `src/components/MarkdownRenderer.tsx` | — | Markdown → React rendering |
| `src/components/PlanReviewBlock.tsx` | — | Plan review with task checklist |
| `src/components/RightPanel.tsx` | — | Diff Viewer + Terminal tabs |
| `src/components/SettingsModal.tsx` | — | Provider, theme, language settings |
| `src/components/Sidebar.tsx` | — | Navigation panel |
| `src/components/SkillsModal.tsx` | — | Skills CRUD + protocol import |
| `src/components/StreamingCursor.tsx` | — | Animated generation cursor |
| `src/components/ThemeStyles.tsx` | — | CSS variable theme system |
| `src/components/ThoughtBlock.tsx` | — | Collapsible thinking block |

## Library Index

| File | Purpose |
|---|---|
| `src/lib/orchestrator.ts` | Agent execution loop |
| `src/lib/streaming.ts` | SSE streaming (multi-provider, Rust proxy) |
| `src/lib/systemPrompt.ts` | System prompt assembly |
| `src/lib/toolSchemas.ts` | OpenAI-format tool definitions |
| `src/lib/toolExecutor.ts` | Tool routing (IPC + MCP) |
| `src/lib/contextTrim.ts` | Middle-out trimming + compaction |
| `src/lib/textToolParser.ts` | XML/JSON tool call parser |
| `src/lib/mcpClient.ts` | MCP HTTP client (JSON-RPC 2.0) |
| `src/lib/ipc.ts` | Tauri IPC wrappers (typed) |
| `src/lib/messageParser.ts` | Stream message parsing |
| `src/lib/modelDiscovery.ts` | Auto-detect local models |
| `src/lib/sanitize.ts` | Output sanitization |
| `src/lib/utils.ts` | Shared utilities |
| `src/lib/icons.tsx` | Icon components for library use |

## State Management

**Zustand Store** (`src/store/useAppStore.ts`):
- Persisted to localStorage via middleware
- Manages: conversations, config, skills, sessions, UI state
- Key state slices:
  - `conversations[]` — message history per session
  - `config` — `AppConfig` (local/cloud provider, workspace, context limit)
  - `skills[]` — active skills (instruction, tool, package)
  - `agentStatus` — `"idle" | "running" | "pending_review" | "error"`
  - `workflowMode` — `"edit" | "plan"`
  - `isPlanApproved` — plan approval flag

## Streaming Interceptors

### StreamingThinkingInterceptor
Routes content matching `<analysis>`, `<thinking>`, `<reasoning>` tags to hidden ThoughtBlock components. This content is **not visible** to users by default (auto-collapsed).

The `onStreamDone` handler strips these tags from the final agent block content, which can leave it empty. Downstream consumers (like `planContent` assembly in ChatArea) must handle this by collecting thought blocks as fallback content.

## ActionCard Flow

```
Orchestrator detects write tool call
  → requestReview({ name, arguments })
  → useAppStore: agentStatus = "pending_review"
  → ActionCard renders with:
      - File path
      - "View Diff" button → opens RightPanel DiffViewer
      - Accept / Reject buttons
  → User clicks Accept:
      - executeTool() called
      - result appended as role:"tool" message
      - agentStatus = "running"
  → User clicks Reject:
      - "User rejected" returned as tool result
      - AI adapts and tries different approach
```

## PlanReviewBlock Flow

```
Plan Mode active + AI outputs <plan> tag
  → agentStatus = "pending_review"
  → PlanReviewBlock renders:
      1. Parse plan content for - [ ] / - [x] checkbox lines
      2. Render task checklist with styled checkboxes
      3. Show progress bar (completed/total)
      4. Strip checkbox lines from markdown body
      5. Render remaining markdown via MarkdownRenderer
  → User clicks "Start Execution":
      - isPlanApproved = true
      - deletePlanFiles() called
      - Continuation message sent (EXECUTION MODE)
      - Agent loop continues with write access
  → User clicks "Reject":
      - Plan discarded, agent returns to idle
```

### Anti-Re-Appear Guard
After plan approval, write tool reviews that set `agentStatus = "pending_review"` won't trigger PlanReviewBlock again because the condition checks `!isPlanApproved`:
```typescript
const isPlanPending = agentStatus === "pending_review" && workflowMode === "plan" && !isPlanApproved;
```

## Conversation Title Generation

Triggered in `onStreamDone` after the first streaming turn:
1. Check `titleGenerated` flag (prevents duplicate generation)
2. Use thought block content as fallback when agent block is empty (due to `<analysis>` stripping)
3. Replace default "New Conversation" with generated title
