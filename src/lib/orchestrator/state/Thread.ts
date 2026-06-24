// src/lib/orchestrator/state/Thread.ts

import type { AgentMessage } from "../types";

export interface TurnItem {
  id: string;
  type: "persistent" | "ephemeral";
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  reasoning?: string;
  reasoning_content?: string;
  toolCallId?: string;
  toolCalls?: any[];
  burned: boolean;
  timestamp: number;
  metadata?: Record<string, any>;
}

export interface ExecutionTurn {
  turnId: string;
  promptMessages: AgentMessage[];
  response?: string;
  toolCalls?: any[];
  toolResults?: any[];
  ephemeralItems: Set<string>; // Item IDs that are marked ephemeral
  startTime: number;
  endTime?: number;
  items: TurnItem[];
  metadata?: Record<string, any>;
}

export interface ConversationThread {
  threadId: string;
  createdAt: number;
  turns: ExecutionTurn[];
  metadata?: Record<string, any>;
}

export function createThread(threadId: string): ConversationThread {
  return {
    threadId,
    createdAt: Date.now(),
    turns: [],
    metadata: {},
  };
}

export function createTurn(turnId: string, promptMessages: AgentMessage[]): ExecutionTurn {
  return {
    turnId,
    promptMessages,
    ephemeralItems: new Set<string>(),
    startTime: Date.now(),
    items: [],
    metadata: {},
  };
}
