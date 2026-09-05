import type { TurnAggregateV1 } from "./aggregate";
import type { RuntimeV2ResultKind, RuntimeV2RunIdentity, RuntimeV2TurnIdentity } from "./contracts";
import { RuntimeV2Controller, type RuntimeV2ControllerSnapshot } from "./controller";
import type { RuntimeV2DecisionInput } from "./decision";
import type { RuntimeV2Ports } from "./ports";
import type { NetworkReadPolicy } from "../networkRead";
import { deriveReadOnlyRecoveryWindow, latestReadOnlyAnswer } from "./readOnlyProgress";
import { RUNTIME_V2_PROVIDER_RECOVERY_STALL_MS } from "./lifecycle";

export interface RuntimeV2ReadOnlyLoopInput {
  readonly ports: RuntimeV2Ports;
  readonly turn: RuntimeV2TurnIdentity;
  readonly run: RuntimeV2RunIdentity;
  readonly objective: string;
  readonly signal: AbortSignal;
  readonly initial?: RuntimeV2ControllerSnapshot;
  readonly now: () => number;
  /** Explicit caller budget only; ordinary local-model Turns have no deadline. */
  readonly deadlineMs?: number;
  readonly allowSkillLoad?: boolean;
  readonly networkRead?: NetworkReadPolicy;
  readonly strategy?: "chat" | "analyze";
  readonly collectWorkspace?: boolean;
  readonly decisionInput?: () => RuntimeV2DecisionInput;
  readonly blocked?: () => { reason: string; finalMarkdown: string } | null;
}
export interface RuntimeV2ReadOnlyLoopResult {
  readonly aggregate: TurnAggregateV1;
  readonly resultKind: RuntimeV2ResultKind;
  readonly reason: string;
}

/** Independent read-only strategies sharing the canonical controller. */
export async function runRuntimeV2ReadOnlyLoop(input: RuntimeV2ReadOnlyLoopInput): Promise<RuntimeV2ReadOnlyLoopResult> {
  const controller = new RuntimeV2Controller(input.ports, input.initial, { abortSignal: input.signal });
  if (!input.initial) await controller.admit({
    turn: input.turn, run: input.run, strategy: input.strategy || "chat", objective: input.objective,
    networkRead: input.networkRead, constraints: ["read_only", "no_external_side_effects"],
    acceptanceCriteria: ["one_visible_provider_reply"], initialPhase: input.collectWorkspace ? "preparing" : "observing",
  });
  const startedAt = controller.snapshot().aggregate?.events.find((event) => event.type === "run.started")?.at ?? input.now();
  if (input.initial?.aggregate?.terminalOutcome || input.initial?.aggregate?.phase === "finalizing") await controller.resumeTerminalProjection();
  while (true) {
    const state = controller.snapshot().aggregate;
    if (!state) throw new Error("RUNTIME_V2_READ_ONLY_AGGREGATE_MISSING");
    if (state.terminalOutcome) break;
    if (input.signal.aborted) { await controller.driveOnce(); continue; }
    const blocked = input.blocked?.();
    if (blocked) {
      await controller.driveOnce({ resultKind: "blocked", resultReason: blocked.reason, finalMarkdown: blocked.finalMarkdown });
      continue;
    }
    if (state.strategy === "chat" && state.pendingToolCalls.some((call) =>
      !(call.name === "load_skill" && input.allowSkillLoad) &&
      !(["web_search", "web_fetch"].includes(call.name) && input.networkRead?.enabled))) {
      await controller.driveOnce({ resultKind: "error", resultReason: "Chat 收到了未授权的工具动作。" });
      continue;
    }
    if (state.scheduledCommands.length) { await controller.resumeScheduled(); continue; }
    // Inspect a slow request's result BEFORE considering elapsed recovery time.
    const answer = latestReadOnlyAnswer(state);
    if (answer && !state.subagents.some((job) => job.status === "queued" || job.status === "running")) {
      await controller.driveOnce({ resultKind: "success", resultReason: "已基于本轮对话与实际证据完成答复。", finalMarkdown: answer });
      continue;
    }
    const recovery = deriveReadOnlyRecoveryWindow(state);
    if (recovery && input.now() - recovery.startedAt >= RUNTIME_V2_PROVIDER_RECOVERY_STALL_MS) {
      await controller.driveOnce({ resultKind: "error", resultReason: "连续无语义进展的恢复租约已耗尽，未生成可发布的回答。" });
      continue;
    }
    const lastRequest = [...state.events].reverse().find((event) => event.type === "command.scheduled" && event.command.kind === "request_model");
    if (lastRequest?.type === "command.scheduled" && lastRequest.command.payload.conclusionKind === "read_only" && !state.pendingToolCalls.length) {
      await controller.driveOnce({ resultKind: "error", resultReason: "总结请求未产生完整、可发布的模型回答。" });
      continue;
    }
    if (input.deadlineMs !== undefined && input.now() - startedAt >= input.deadlineMs) {
      await controller.driveOnce({ resultKind: "error", resultReason: "调用方指定的运行时限已到，未生成可发布的回答。" });
      continue;
    }
    if (state.phase === "preparing" && (state.strategy === "chat" || state.evidence.length)) {
      await controller.changePhase("observing", "已取得概览，继续读取缺失的证据或回答。");
      continue;
    }
    if (!await controller.driveOnce(input.decisionInput?.())) {
      await controller.driveOnce({ resultKind: "error", resultReason: "没有可继续的只读动作或可发布的模型回答。" });
    }
  }
  const aggregate = controller.snapshot().aggregate!;
  const terminal = aggregate.terminalOutcome!;
  return { aggregate, resultKind: terminal.resultKind, reason: terminal.reason };
}
