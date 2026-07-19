// src/lib/orchestrator/state/Thread.ts
// Thread/Turn/Item state used by the production iteration context.
// The functional helpers below are the live API.
// ────────────────────────────────────────────────────────────────────

import type { AgentMessage } from "../types";

export type ItemCategory =
  | "system"
  | "user"
  | "assistant"
  | "tool"
  | "memory"
  | "pinned_summary";

export interface TurnItem {
  id: string;
  category: ItemCategory;
  scope: "persistent" | "ephemeral";
  purpose: string;
  createdAt: number;
  burned: boolean;
  source?: {
    toolName?: string;
    filePath?: string;
    messageIndex?: number;
  };
}

export interface ToolExecutionRecord {
  toolCallId: string;
  toolName: string;
  argumentsHash: string;
  resultLength: number;
  resultTruncated: boolean;
  burnt: boolean;
}

export interface ExecutionTurn {
  turnId: string;
  sessionId: string;
  turnIndex: number;
  startTime: number;
  endTime: number | null;
  status: "building" | "streaming" | "evaluating" | "completed" | "failed";
  modelProvider: string;
  modelName: string;
  promptMessageCount: number;
  estimatedPromptTokens: number;
  estimatedResponseTokens: number;
  toolExecutions: ToolExecutionRecord[];
  items: TurnItem[];
  reasoningDominated: boolean;
  summary?: string;
  // Legacy fields for backward compat
  promptMessages?: AgentMessage[];
  ephemeralItems?: Set<string>;
}

// ── Functional thread API ─────────────────────────────────────────────

export interface LegacyConversationThread {
  threadId: string;
  createdAt: number;
  turns: ExecutionTurn[];
  metadata?: Record<string, any>;
}

export function createThread(threadId: string): LegacyConversationThread {
  return { threadId, createdAt: Date.now(), turns: [], metadata: {} };
}

export function createTurn(turnId: string, promptMessages: AgentMessage[]): ExecutionTurn {
  return {
    turnId,
    sessionId: turnId.split("-")[0] ?? "default",
    turnIndex: 0,
    startTime: Date.now(),
    endTime: null,
    status: "building",
    modelProvider: "local",
    modelName: "unknown",
    promptMessageCount: 0,
    estimatedPromptTokens: 0,
    estimatedResponseTokens: 0,
    toolExecutions: [],
    items: [],
    reasoningDominated: false,
    promptMessages,
    ephemeralItems: new Set<string>(),
  };
}
