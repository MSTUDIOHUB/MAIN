// src/lib/orchestrator/state/TurnContext.ts
// TurnContext holds mutable turn state and the ephemeral item registry.
// Supports both legacy (ExecutionTurn-based) and new (sessionId-based) APIs.
// ────────────────────────────────────────────────────────────────────

import { generateId } from "../../utils";
import type { TurnItem, ToolExecutionRecord, ExecutionTurn } from "./Thread";

export interface BurnedReplacement {
  replacementText: string;
  originalLength: number;
}

export class TurnContext {
  readonly turnId: string;
  readonly sessionId: string;
  private ephemeralItems: Map<string, TurnItem> = new Map();
  private persistentItems: Map<string, TurnItem> = new Map();
  private burnedReplacements: BurnedReplacement[] = [];
  private toolExecutions: Map<string, ToolExecutionRecord> = new Map();
  private reasoningAccumulated = 0;
  private summary = "";

  // Legacy support: execution turn reference
  private legacyTurn?: ExecutionTurn;

  // ── Constructor: supports both new (sessionId) and legacy (ExecutionTurn) APIs ──
  constructor(sessionIdOrTurn: string | ExecutionTurn) {
    if (typeof sessionIdOrTurn === "string") {
      this.turnId = generateId();
      this.sessionId = sessionIdOrTurn;
    } else {
      this.legacyTurn = sessionIdOrTurn;
      this.turnId = sessionIdOrTurn.turnId;
      this.sessionId = sessionIdOrTurn.sessionId ?? "default";
      // Backfill ephemeral items from legacy turn
      if (sessionIdOrTurn.ephemeralItems) {
        for (const id of sessionIdOrTurn.ephemeralItems) {
          this.ephemeralItems.set(id, {
            id,
            category: "tool" as const,
            scope: "ephemeral",
            purpose: "ephemeral tool output",
            createdAt: Date.now(),
            burned: false,
          });
        }
      }
    }
  }

  setSummary(s: string): void { this.summary = s; }
  getSummary(): string { return this.summary; }

  // ── Legacy compat ──────────────────────────────────────────────────

  startTurn(): void {
    if (this.legacyTurn) this.legacyTurn.startTime = Date.now();
  }

  addItem(item: Omit<TurnItem, "id" | "createdAt">): TurnItem {
    const newItem: TurnItem = { ...item, id: generateId(), createdAt: Date.now() };
    if (item.scope === "ephemeral") {
      this.ephemeralItems.set(newItem.id, newItem);
    } else {
      this.persistentItems.set(newItem.id, newItem);
    }
    if (this.legacyTurn) {
      this.legacyTurn.items.push(newItem);
    }
    return newItem;
  }

  markAsEphemeral(itemId: string): void {
    this.ephemeralItems.set(itemId, this.persistentItems.get(itemId) || {
      id: itemId, category: "tool" as const, scope: "ephemeral", purpose: "marked ephemeral", createdAt: Date.now(), burned: false
    });
    if (this.persistentItems.has(itemId)) this.persistentItems.delete(itemId);
    if (this.legacyTurn) this.legacyTurn.ephemeralItems?.add(itemId);
  }

  markAsPersistent(itemId: string): void {
    this.persistentItems.set(itemId, this.ephemeralItems.get(itemId) || {
      id: itemId, category: "assistant" as const, scope: "persistent", purpose: "marked persistent", createdAt: Date.now(), burned: false
    });
    if (this.ephemeralItems.has(itemId)) this.ephemeralItems.delete(itemId);
    if (this.legacyTurn) this.legacyTurn.ephemeralItems?.delete(itemId);
  }

  getBurnableItems(): TurnItem[] {
    return [...this.ephemeralItems.values()].filter(i => !i.burned);
  }

  getTurn(): ExecutionTurn {
    if (this.legacyTurn) return this.legacyTurn;
    return {
      turnId: this.turnId, sessionId: this.sessionId, turnIndex: 0, startTime: 0, endTime: null,
      status: "building" as const, modelProvider: "local", modelName: "unknown",
      promptMessageCount: 0, estimatedPromptTokens: 0, estimatedResponseTokens: 0,
      toolExecutions: [] as import("./Thread").ToolExecutionRecord[], items: [] as import("./Thread").TurnItem[],
      reasoningDominated: false,
    };
  }

  // ── New API: ephemeral / persistent registry ───────────────────────

  registerEphemeral(category: TurnItem["category"], purpose: string, source?: TurnItem["source"]): string {
    const id = generateId();
    const item: TurnItem = { id, category, scope: "ephemeral", purpose, createdAt: Date.now(), burned: false, source };
    this.ephemeralItems.set(id, item);
    return id;
  }

  registerPersistent(category: TurnItem["category"], purpose: string, source?: TurnItem["source"]): string {
    const id = generateId();
    const item: TurnItem = { id, category, scope: "persistent", purpose, createdAt: Date.now(), burned: false, source };
    this.persistentItems.set(id, item);
    return id;
  }

  markBurned(itemId: string): boolean {
    if (this.ephemeralItems.has(itemId)) { this.ephemeralItems.get(itemId)!.burned = true; return true; }
    if (this.persistentItems.has(itemId)) { this.persistentItems.get(itemId)!.burned = true; return true; }
    return false;
  }

  getBurnableEphemeralIds(): string[] {
    return [...this.ephemeralItems.values()].filter(i => !i.burned).map(i => i.id);
  }

  getPersistentItemIds(): string[] {
    return [...this.persistentItems.values()].map(i => i.id);
  }

  // ── Tool execution tracking ────────────────────────────────────────

  registerToolExecution(record: Omit<ToolExecutionRecord, "burnt">): void {
    this.toolExecutions.set(record.toolCallId, { ...record, burnt: false });
  }

  burnToolExecution(toolCallId: string): void {
    const ex = this.toolExecutions.get(toolCallId);
    if (ex) ex.burnt = true;
  }

  getBurnedToolCount(): number { return [...this.toolExecutions.values()].filter(e => e.burnt).length; }
  getTotalToolCount(): number { return this.toolExecutions.size; }

  // ── Reasoning tracking ─────────────────────────────────────────────

  accumulateReasoning(chars: number): void { this.reasoningAccumulated += chars; }
  getReasoningAccumulated(): number { return this.reasoningAccumulated; }
  resetReasoning(): void { this.reasoningAccumulated = 0; }

  // ── Burned replacements ────────────────────────────────────────────

  recordBurnedReplacement(replacement: BurnedReplacement): void { this.burnedReplacements.push(replacement); }
  getBurnedReplacements(): BurnedReplacement[] { return this.burnedReplacements; }

  toTurnSummary(): string {
    const parts: string[] = [];
    if (this.summary) parts.push(this.summary);
    if (this.burnedReplacements.length > 0) parts.push(`Burned ${this.burnedReplacements.length} ephemeral items.`);
    if (this.reasoningAccumulated > 0) parts.push(`Processed ${this.reasoningAccumulated} chars reasoning (purged).`);
    return parts.join(" ");
  }
}
