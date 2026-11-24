import { expect } from "@playwright/test";
import { GLOBAL_CHAT_KEY, resolveGlobalChatSessionKey } from "../../src/lib/sessionTypes";
import { normalizeNetworkRead } from "../../src/lib/networkRead";

export interface RealOmlxWebInvocation {
  cmd: string;
  args: Record<string, any>;
  owner: { turn: any; run: any } | null;
  commandKey: string | null;
  status: "pending" | "fulfilled" | "rejected";
  startedAt: number;
  finishedAt?: number;
  responseProvider?: string;
  fallbackProvider?: string | null;
  error?: string;
}

export function canonicalChatNetworkRead(aggregate: any) {
  const admitted = aggregate?.events?.find((event: any) => event.type === "turn.admitted")?.networkRead;
  if (aggregate?.networkRead !== undefined && admitted !== undefined) {
    expect(normalizeNetworkRead(aggregate.networkRead)).toEqual(normalizeNetworkRead(admitted));
  }
  // Missing legacy authority is offline; never recover permission from live UI.
  return normalizeNetworkRead(aggregate?.networkRead ?? admitted);
}

/** Inspect the actual Rust bridge boundary, not the model's optional provider
 * argument. Local pre-execution rejects need not have a native invocation. */
export function expectActualWebReadProviders(
  aggregate: any,
  invocations: readonly RealOmlxWebInvocation[],
  requireSettled = true,
) {
  const policy = canonicalChatNetworkRead(aggregate);
  const commands = aggregate.events.filter((event: any) => event.type === "command.scheduled" &&
    ["web_search", "web_fetch"].includes(event.command.payload.toolName)).map((event: any) => event.command);
  const commandsByKey = new Map<string, any>(commands.map((command: any) => [command.idempotencyKey, command]));
  const receipts = aggregate.events.filter((event: any) => event.type === "tool.completed");
  const calls = invocations.filter(call => commandsByKey.has(String(call.commandKey)) ||
    call.owner?.run?.runId === aggregate.run.identity.runId);
  for (const call of calls) {
    const command = commandsByKey.get(String(call.commandKey));
    expect(command, "native web IPC must bind an exact scheduled command").toBeTruthy();
    expect(call.owner?.turn).toEqual(aggregate.turn);
    expect(call.owner?.run).toEqual(aggregate.run.identity);
    expect(call.cmd).toBe(command.payload.toolName);
    expect(policy.enabled, "native web reads require canonical network authority").toBe(true);
    const key = call.cmd === "web_search" ? "query" : "url";
    expect(call.args[key]).toBe(command.payload.arguments[key]);
    if (call.cmd === "web_search") {
      expect(call.args.provider, "actual IPC must use the frozen selected provider").toBe(policy.provider);
      expect(call.args.allowFallback).toBe(false);
      if (call.status === "fulfilled") {
        expect(call.responseProvider).toBe(policy.provider);
        expect(call.fallbackProvider ?? null).toBeNull();
      }
    }
    if (requireSettled) {
      expect(["fulfilled", "rejected"]).toContain(call.status);
      expect(receipts.some((receipt: any) => receipt.idempotencyKey === call.commandKey)).toBe(true);
    }
  }
  for (const receipt of receipts.filter((entry: any) => entry.status === "succeeded" &&
    commandsByKey.has(entry.idempotencyKey))) {
    expect(calls.some(call => call.commandKey === receipt.idempotencyKey && call.status === "fulfilled"),
      "a successful web receipt needs its real native invocation").toBe(true);
  }
  return { policy, invocations: calls };
}

/** A natural routing decision is not an effect receipt. These questions still
 * require a read-only global result regardless of the admitted runner. */
export function expectGlobalReadOnlyChatReply(input: {
  before: { snapshot: any; readOnly: any };
  settled: { snapshot: any; readOnly: any };
  interpretIntent: boolean;
}) {
  const { before, settled, interpretIntent } = input;
  const snapshot = settled.readOnly;
  const aggregate = snapshot.aggregate;
  if (interpretIntent) {
    // deriveSemanticIntent can legally admit Execute (e.g. operate plus an
    // external capability). This never grants permission for extra effects.
    expect(["chat", "analyze", "execute"]).toContain(aggregate.strategy);
  } else {
    // The trusted fixture explicitly submits resolvedIntent=respond here.
    expect(aggregate.strategy).toBe("chat");
  }
  const expectedSessionId = before.snapshot.currentSessionId;
  const expectedSessionKey = resolveGlobalChatSessionKey(expectedSessionId);
  const expectedEpoch = before.readOnly.session?.planLifecycleEpoch;
  expect(expectedSessionKey).not.toBeNull();
  expect(typeof expectedEpoch).toBe("string");
  expect(expectedEpoch.length).toBeGreaterThan(0);
  expect(String(before.snapshot.currentWorkspace || "").trim()).toBe("");
  expect(String(settled.snapshot.currentWorkspace || "").trim()).toBe("");
  expect(settled.snapshot.currentSessionId).toBe(expectedSessionId);
  expect(snapshot.session.id).toBe(expectedSessionId);
  expect(snapshot.session.planLifecycleEpoch).toBe(expectedEpoch);
  expect(aggregate.turn.workspaceKey).toBe(GLOBAL_CHAT_KEY);
  expect(aggregate.turn.sessionKey).toBe(expectedSessionKey);
  expect(aggregate.turn.sessionEpoch).toBe(expectedEpoch);
  expect(aggregate.turn.turnId).toBe(snapshot.turn.id);
  expect(aggregate.turn.turnId).not.toBe(before.readOnly.aggregate?.turn?.turnId);
  const run = aggregate.run.identity;
  expect(run).toMatchObject({ sessionKey: expectedSessionKey, sessionEpoch: expectedEpoch,
    turnId: aggregate.turn.turnId, parentRunId: null });
  expect(run.runId.length).toBeGreaterThan(0);
  expect(aggregate.events.filter((event: any) => event.type === "turn.admitted")).toHaveLength(1);
  expect(aggregate.events.find((event: any) => event.type === "turn.admitted").turn).toEqual(aggregate.turn);
  expect(aggregate.events.filter((event: any) => event.type === "run.started")).toHaveLength(1);
  for (const event of aggregate.events) if (event.run) expect(event.run).toEqual(run);
  expect(settled.snapshot.activeActionRequest).toBeNull();

  // Discovery, Skill/context reads and the canonical Execute contract recorder
  // are inert controls. The only external data effects allowed are the actual
  // built-in web reads; unknown MCP/application tools do not inherit this scope.
  const readOnlyTools = new Set(["tool_search", "load_skill", "knowledge_search", "knowledge_get_excerpt",
    "web_search", "web_fetch", "record_execution_contract"]);
  const effectCommands = aggregate.events.filter((event: any) => event.type === "command.scheduled" &&
    ["execute_tool", "execute_validation", "schedule_subagents"].includes(event.command.kind));
  for (const event of effectCommands) {
    expect(event.command.kind).toBe("execute_tool");
    expect(readOnlyTools.has(event.command.payload.toolName),
      `global read-only question cannot schedule ${event.command.payload.toolName}`).toBe(true);
  }
  const completedTools = aggregate.events.filter((event: any) => event.type === "tool.completed");
  for (const event of completedTools) {
    expect(event.mutationRequests || []).toEqual([]);
    if (event.presentation?.toolName) expect(readOnlyTools.has(event.presentation.toolName),
      `global read-only question cannot complete ${event.presentation.toolName}`).toBe(true);
    expect((event.evidence || []).some((entry: any) => entry.kind === "mutation")).toBe(false);
  }
  expect(aggregate.evidence.some((entry: any) => entry.kind === "mutation")).toBe(false);
  expect(aggregate.events.some((event: any) => event.type === "work_plan.approved")).toBe(false);
  return {
    strategy: aggregate.strategy, naturalAdmission: interpretIntent,
    owner: { turn: aggregate.turn, run },
    scheduledTools: effectCommands.map((event: any) => ({ commandKey: event.command.idempotencyKey, toolName: event.command.payload.toolName })),
    actualWebReceipts: completedTools.filter((event: any) => ["web_search", "web_fetch"].includes(event.presentation?.toolName))
      .map((event: any) => ({ commandKey: event.idempotencyKey, status: event.status, toolName: event.presentation.toolName })),
    mutationEvidenceCount: 0,
  };
}
