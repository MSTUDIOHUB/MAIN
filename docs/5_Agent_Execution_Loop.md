# MAIN — Agent Execution Loop (The Orchestrator)

The orchestrator (`src/lib/orchestrator.ts`) is the core agent loop that drives multi-turn LLM interaction with tool execution, human-in-the-loop safety, and self-healing error recovery.

## 1. High-Level Flow

```
executeAgentLoop(callbacks, abortController)
  │
  ├─ 1. Derive StreamSettings from AppConfig
  ├─ 2. Discover MCP tools from configured servers
  ├─ 3. Build merged tool definitions (built-in + skill + MCP)
  ├─ 4. Refresh system prompt (dynamic per-invocation)
  │
  └─ while (iteration < MAX_ITERATIONS=25):
       │
       ├─ 5. startNewTurn() — reset turn state
       ├─ 6. manageContext() — compact + trim
       ├─ 7. fetchLLMStream() — SSE streaming
       │   ├─ On context_length_exceeded → reactive compact + retry
       │   ├─ On finish_reason="length" → escalate max_tokens + retry
       │   └─ On success → parse tool calls
       │
       ├─ 8. Parse tool calls (native API → text fallback)
       ├─ 9. No tool calls?
       │   ├─ Plan Mode + <plan> tag? → waitForPlanApproval()
       │   ├─ Intent detected but no tool use? → re-prompt (max 3 times)
       │   └─ Otherwise → idle (done)
       │
       ├─ 10. Partition tool calls:
       │   ├─ Read-only → auto-execute concurrently
       │   ├─ Spec file writes → auto-approve (Plan Mode)
       │   └─ Write/execute → human review via requestReview()
       │
       ├─ 11. Execute tools + append results
       ├─ 12. Check repetition loop guard
       └─ 13. Continue loop
```

## 2. Context Management Pipeline

Applied at the start of every iteration via `manageContext()`:

```
Input Messages
     ↓
[1] compactToolResults() — Microcompact
    - Truncate individual tool results exceeding maxToolResultTokens (2000)
    - Append "...[compact: N chars omitted]" marker
     ↓
[2] trimMessagesToContext() — Middle-out Trim
    - Reserve 25% of context for output (outputBudget)
    - Always keep system message
    - Keep most recent messages (reverse iteration)
    - Drop oldest messages, insert compact summary marker
    - Atomic pairing: tool results kept with parent assistant message
     ↓
Output Messages (fit within context window)
```

### Reactive Compaction
When a `context_length_exceeded` error occurs during streaming:
1. First retry: Aggressive compact (reduce output budget to 2048, maxToolResultTokens to 2000)
2. Second retry: Strip all `tool_calls` from message history, convert tool results to compact text
3. Third failure: Report error to user — context too long even after compaction

### Token Estimation
Conservative estimate for mixed CJK/Latin text:
```typescript
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 2.5); // ~2.5 chars/token
}
```
Plus 10 tokens overhead per message for role + formatting.

## 3. Streaming Architecture

### Dual-Path Streaming
```
streamChatCompletion()
├── Local (localhost) → direct fetch() → ReadableStream → SSE parsing
└── Cloud/LAN → invoke("start_chat_stream") → Rust proxy → Tauri events
    ├── chat-stream-chunk → processSSEChunk()
    └── chat-stream-done → resolve result
```

### Provider-Specific Formatting
| Provider | Endpoint | Format | Tools Parameter |
|---|---|---|---|
| **Ollama** | `/api/chat` | Native Ollama format | Not supported |
| **Others** | `/v1/chat/completions` | OpenAI-compatible | `tools` array |

### Max Output Tokens Escalation
When `finish_reason === "length"` (response truncated):
```
4K → 8K → 16K → 32K → 64K (MAX_TOKENS_LADDER)
```
Up to 3 escalation attempts. Each retry clears previous streaming content and re-requests with higher `max_tokens`.

### Thinking Model Support
Models like Qwen3.5/DeepSeek-R1 emit `reasoning_content` in SSE deltas:
1. Buffer reasoning tokens until verified as non-garbled
2. If content is real text → emit wrapped in `<thinking>...</thinking>` tags
3. If content is all `"?"` (garbled llama.cpp tokens) → cancel stream, surface error with suggestions
4. Close reasoning block when regular `content` delta arrives

## 4. Tool Call Parsing

The orchestrator tries two parsing strategies:

### 4.1 Native Function Calling (preferred)
If the API response includes `tool_calls` in the `choices[0].message`, these are used directly:
```json
{
  "tool_calls": [
    { "id": "call_abc", "function": { "name": "read_file", "arguments": "{\"path\":\"src/main.rs\"}" } }
  ]
}
```

### 4.2 XML Text Fallback (textToolParser.ts)
For models without native function calling, parses XML from the text response:
```xml
<tool_use>
<tool>read_file</tool>
<parameter name="path">src/main.rs