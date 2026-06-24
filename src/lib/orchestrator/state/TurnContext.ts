// src/lib/orchestrator/state/TurnContext.ts

import type { TurnItem, ExecutionTurn } from "./Thread";

export class TurnContext {
  private turn: ExecutionTurn;
  private currentItems: TurnItem[] = [];

  constructor(turn: ExecutionTurn) {
    this.turn = turn;
    this.currentItems = [...turn.items];
  }

  startTurn() {
    this.turn.startTime = Date.now();
  }

  addItem(item: Omit<TurnItem, "burned" | "timestamp">): TurnItem {
    const fullItem: TurnItem = {
      ...item,
      burned: false,
      timestamp: Date.now(),
    };
    this.currentItems.push(fullItem);
    this.turn.items = [...this.currentItems];
    if (fullItem.type === "ephemeral") {
      this.turn.ephemeralItems.add(fullItem.id);
    }
    return fullItem;
  }

  markAsEphemeral(itemId: string) {
    this.turn.ephemeralItems.add(itemId);
    this.currentItems = this.currentItems.map((item) => {
      if (item.id === itemId) {
        return { ...item, type: "ephemeral" };
      }
      return item;
    });
    this.turn.items = [...this.currentItems];
  }

  markAsPersistent(itemId: string) {
    this.turn.ephemeralItems.delete(itemId);
    this.currentItems = this.currentItems.map((item) => {
      if (item.id === itemId) {
        return { ...item, type: "persistent" };
      }
      return item;
    });
    this.turn.items = [...this.currentItems];
  }

  getBurnableItems(): TurnItem[] {
    return this.currentItems.filter(
      (item) => item.type === "ephemeral" || this.turn.ephemeralItems.has(item.id)
    );
  }

  getTurn(): ExecutionTurn {
    return this.turn;
  }

  endTurn() {
    this.turn.endTime = Date.now();
    this.turn.items = [...this.currentItems];
  }
}
