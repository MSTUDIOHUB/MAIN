import {
  createRuntimeV2Checkpoint,
  normalizeRuntimeV2Checkpoint,
  replayRuntimeV2Events,
  serializeRuntimeV2CheckpointMap,
} from "./runtime-v2/checkpoint";
import type { TurnAggregateV1 } from "./runtime-v2/aggregate";
import { extractExactReadFileWindow } from "./readFileWindow";
import {
  collectTerminalCredentialValues,
  mapReceiptText,
  createKnownTerminalCredentialRedactor,
} from "./terminalCredentials";

type JsonRecord = Record<string, unknown>;
export type TerminalCredentialCleanupPlan<T> =
  | { disposition: "unchanged" | "redacted"; snapshot: T }
  | { disposition: "deferred"; reason: "resumable_checkpoint" | "invalid_checkpoint" };

const SHELL_OBSERVATIONS = new Set([
  "run_command", "execute_command", "read_pty_buffer", "read_pty_since", "read_pty_tail", "get_pty_status", "send_pty_input",
]);

function record(value: unknown): value is JsonRecord {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function hasPublishedTerminalOutcome(aggregate: TurnAggregateV1 | null | undefined): boolean {
  return !!aggregate?.terminalOutcome &&
    aggregate.finalProjectionId === aggregate.terminalOutcome.finalProjectionId &&
    aggregate.events.some(event => event.type === "turn.completed");
}

function collectReceiptCredentials(value: unknown, credentials: Set<string>): void {
  if (!Array.isArray(value)) return;
  const shellCalls = new Set<string>();
  for (const row of value) {
    if (!record(row)) continue;
    const command = record(row.command) ? row.command : null;
    if (row.type === "command.scheduled" && command && record(command.payload) &&
      SHELL_OBSERVATIONS.has(String(command.payload.toolName)) && typeof command.idempotencyKey === "string") {
      shellCalls.add(command.idempotencyKey);
    }
    if (!Array.isArray(row.tool_calls)) continue;
    for (const call of row.tool_calls) {
      if (record(call) && record(call.function) && SHELL_OBSERVATIONS.has(String(call.function.name)) && typeof call.id === "string") {
        shellCalls.add(call.id);
      }
    }
  }
  for (const row of value) {
    if (!record(row)) continue;
    const presentation = record(row.presentation) ? row.presentation : null;
    const shellResult = [row.toolName, row.executionName, row.operationName, row.name, presentation?.toolName]
      .some(name => typeof name === "string" && SHELL_OBSERVATIONS.has(name)) ||
      (row.type === "tool.completed" && shellCalls.has(String(row.idempotencyKey))) ||
      (row.role === "tool" && shellCalls.has(String(row.tool_call_id)));
    if (!shellResult) continue;
    mapReceiptText([row.modelContent, row.content, row.output, row.stdout, row.stderr, row.result, row.message,
      row.diagnosticDetails, row.observationSummary, presentation?.message, presentation?.observationSummary], text => {
      collectTerminalCredentialValues(text, credentials);
      return text;
    });
  }
}

class DeferredTerminalCredentialCleanup extends Error {
  constructor(readonly reason: "resumable_checkpoint" | "invalid_checkpoint") { super(reason); }
}

function redactCheckpoint(value: unknown, redact: (text: string) => string): unknown {
  if (!record(value) || !Array.isArray(value.events)) return value;
  const edited = mapReceiptText(value.events, redact);
  if (edited === value.events) return value;
  try {
    const original = normalizeRuntimeV2Checkpoint(value);
    if (!original) throw new DeferredTerminalCredentialCleanup("invalid_checkpoint");
    if (!hasPublishedTerminalOutcome(original.aggregate)) throw new DeferredTerminalCredentialCleanup("resumable_checkpoint");
    const events = mapReceiptText(original.events, redact);
    const aggregate = replayRuntimeV2Events(events);
    if (!aggregate || !hasPublishedTerminalOutcome(aggregate)) throw new DeferredTerminalCredentialCleanup("invalid_checkpoint");
    return serializeRuntimeV2CheckpointMap({
      [original.owner.turnId]: createRuntimeV2Checkpoint({
        revision: original.revision, aggregate, updatedAt: original.updatedAt,
      }),
    })[original.owner.turnId];
  } catch (error) {
    if (error instanceof DeferredTerminalCredentialCleanup) throw error;
    throw new DeferredTerminalCredentialCleanup("invalid_checkpoint");
  }
}

function terminalCredentialsInHistory(snapshot: unknown, related: readonly unknown[] = []): ReadonlySet<string> {
  const scopes = [snapshot, ...related].flatMap(value => record(value) && record(value.runtimeSnapshot) ? [value, value.runtimeSnapshot] : [value]);
  const credentials = new Set<string>();
  for (const scope of scopes) {
    if (Array.isArray(scope)) collectReceiptCredentials(scope, credentials);
    if (!record(scope)) continue;
    collectReceiptCredentials(scope.events, credentials);
    for (const field of ["messages", "agentMessages", "taskFlow"]) collectReceiptCredentials(scope[field], credentials);
    if (record(scope.runtimeV2Checkpoints)) {
      for (const checkpoint of Object.values(scope.runtimeV2Checkpoints)) {
        if (record(checkpoint)) collectReceiptCredentials(checkpoint.events, credentials);
      }
    }
  }
  return credentials;
}

/** A display, export, or provider message projection has no checkpoint or
 * execution authority. Callers pass their derived values to this projection. */
type TerminalCredentialProjection = <T>(value: T) => T;

export function createTerminalCredentialProjection(source: unknown): TerminalCredentialProjection {
  const credentials = terminalCredentialsInHistory(source);
  if (!credentials.size) return value => value;
  const redact = createKnownTerminalCredentialRedactor(credentials);
  return value => mapReceiptText(value, redact);
}

/** A redacted source window no longer demonstrates exact-byte coverage. */
export function projectTerminalCredentialModelMessages<T extends { role: string; content?: unknown }>(
  messages: T[], project: TerminalCredentialProjection,
): T[] {
  const safe = project(messages);
  if (safe === messages) return messages;
  return safe.map((message, index) => {
    const original = messages[index];
    if (message.role !== "tool" || message.content === original.content ||
        typeof original.content !== "string" || !extractExactReadFileWindow(original.content)) return message;
    return { ...message, content: "The historical source window contains a redacted credential. Exact source coverage is unavailable." };
  });
}

/** Verify and replay before replacing a sealed checkpoint. An affected
 * resumable or unverifiable checkpoint defers the entire Session owner. */
export function planSessionTerminalCredentialCleanup<T>(snapshot: T, related: readonly unknown[] = []): TerminalCredentialCleanupPlan<T> {
  const credentials = terminalCredentialsInHistory(snapshot, related);
  if (!credentials.size) return { disposition: "unchanged", snapshot };
  const redact = createKnownTerminalCredentialRedactor(credentials);
  const rewriteScope = (scope: unknown): unknown => {
    if (!record(scope)) return mapReceiptText(scope, redact);
    let changed = false;
    const next = Object.fromEntries(Object.entries(scope).map(([field, value]) => {
      let edited: unknown;
      if (field === "runtimeSnapshot") edited = rewriteScope(value);
      else if (field === "runtimeV2Checkpoints" && record(value)) {
        const checkpoints = Object.entries(value);
        const rewritten = checkpoints.map(([id, checkpoint]) => [id, redactCheckpoint(checkpoint, redact)]);
        edited = rewritten.some((entry, index) => entry[1] !== checkpoints[index][1]) ? Object.fromEntries(rewritten) : value;
      } else if (field === "runtimeCheckpoints") edited = value;
      else edited = mapReceiptText(value, redact);
      changed ||= edited !== value;
      return [field, edited];
    }));
    return changed ? next : scope;
  };
  try {
    const next = rewriteScope(snapshot) as T;
    return { disposition: next === snapshot ? "unchanged" : "redacted", snapshot: next };
  } catch (error) {
    if (error instanceof DeferredTerminalCredentialCleanup) return { disposition: "deferred", reason: error.reason };
    throw error;
  }
}
