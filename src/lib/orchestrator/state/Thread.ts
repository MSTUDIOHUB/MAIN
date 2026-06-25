// src/lib/orchestrator/state/Thread.ts
// Thread/Turn/Item state machine — Codex-rs inspired architecture.
// Provides both class-based (ConversationThread) and functional (createThread) APIs
// for backward compatibility.
// ────────────────────────────────────────────────────────────────────

import { generateId } from "../../utils";
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

export interface ThreadMetrics {
  totalTurns: number;
  completedTurns: number;
  failedTurns: number;
  totalToolCalls: number;
  totalEphemeralBurned: number;
  estimatedCurrentTokens: number;
  estimatedPeakTokens: number;
}

// ── ConversationThread class (new API) ────────────────────────────────

export class ConversationThread {
  readonly id: string;
  readonly sessionId: string;
  readonly createdAt: number;
  private turns: ExecutionTurn[] = [];
  private metrics: ThreadMetrics;

  constructor(sessionId: string) {
    this.id = generateId();
    this.sessionId = sessionId;
    this.createdAt = Date.now();
    this.metrics = {
      totalTurns: 0,
      completedTurns: 0,
      failedTurns: 0,
      totalToolCalls: 0,
      totalEphemeralBurned: 0,
      estimatedCurrentTokens: 0,
      estimatedPeakTokens: 0,
    };
  }

  createTurn(params: { modelProvider: string; modelName: string }): ExecutionTurn {
    const turn: ExecutionTurn = {
      turnId: generateId(),
      sessionId: this.sessionId,
      turnIndex: this.turns.length,
      startTime: Date.now(),
      endTime: null,
      status: "building",
      modelProvider: params.modelProvider,
      modelName: params.modelName,
      promptMessageCount: 0,
      estimatedPromptTokens: 0,
      estimatedResponseTokens: 0,
      toolExecutions: [],
      items: [],
      reasoningDominated: false,
    };
    this.turns.push(turn);
    this.metrics.totalTurns++;
    return turn;
  }

  completeTurn(turnId: string, m: Partial<Pick<ExecutionTurn, "estimatedPromptTokens" | "estimatedResponseTokens"> & { toolCallCount: number }>): void {
    const turn = this.turns.find(t => t.turnId === turnId);
    if (!turn) return;
    turn.status = "completed";
    turn.endTime = Date.now();
    turn.estimatedPromptTokens = m.estimatedPromptTokens ?? turn.estimatedPromptTokens;
    turn.estimatedResponseTokens = m.estimatedResponseTokens ?? turn.estimatedResponseTokens;
    this.metrics.totalToolCalls += m.toolCallCount ?? 0;
    this.metrics.completedTurns++;
    this.calcTokens();
  }

  failTurn(turnId: string, reason?: string): void {
    const turn = this.turns.find(t => t.turnId === turnId);
    if (!turn) return;
    turn.status = "failed";
    turn.endTime = Date.now();
    turn.summary = reason ?? "Turn failed";
    this.metrics.failedTurns++;
  }

  recordToolExecution(turnId: string, rec: Omit<ToolExecutionRecord, "burnt">): void {
    const turn = this.turns.find(t => t.turnId === turnId);
    if (!turn) return;
    turn.toolExecutions.push({ ...rec, burnt: false });
  }

  burnToolExecution(turnId: string, toolCallId: string): void {
    const turn = this.turns.find(t => t.turnId === turnId);
    if (!turn) return;
    const ex = turn.toolExecutions.find(e => e.toolCallId === toolCallId);
    if (ex) { ex.burnt = true; this.metrics.totalEphemeralBurned++; }
  }

  addItem(turnId: string, item: Omit<TurnItem, "id" | "createdAt">): TurnItem {
    const turn = this.turns.find(t => t.turnId === turnId);
    if (!turn) throw new Error(`Turn ${turnId} not found`);
    const newItem: TurnItem = { ...item, id: generateId(), createdAt: Date.now() };
    turn.items.push(newItem);
    return newItem;
  }

  latestTurn(): ExecutionTurn | undefined { return this.turns[this.turns.length - 1]; }
  getTurns(): ExecutionTurn[] { return this.turns; }
  getMetrics(): ThreadMetrics { return { ...this.metrics }; }

  getTurnSummaries(maxLast: number = 3): string {
    return this.turns.filter(t => t.status === "completed" && t.summary)
      .slice(-maxLast).map(t => t.summary!).filter(Boolean).join("\n");
  }

  private calcTokens(): void {
    let cur = 0;
    for (const t of this.turns) {
      if (t.status === "completed") cur += (t.estimatedPromptTokens || 0) + (t.estimatedResponseTokens || 0);
    }
    this.metrics.estimatedCurrentTokens = cur;
    if (cur > this.metrics.estimatedPeakTokens) this.metrics.estimatedPeakTokens = cur;
  }

  // Legacy: for backward compat with old orchestrator code
  get threadId() { return this.id; }
  get turnsList() { return this.turns; }
}

// ── Legacy functional API (backward compat) ───────────────────────────

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
