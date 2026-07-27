import type { TurnAggregateV1 } from "./aggregate";
import type {
  RuntimeV2ResultKind,
  RuntimeV2RunIdentity,
  RuntimeV2TurnIdentity,
} from "./contracts";
import { RuntimeV2Controller, type RuntimeV2ControllerSnapshot } from "./controller";
import type { RuntimeV2Ports } from "./ports";

export interface RuntimeV2ChatLoopInput {
  readonly ports: RuntimeV2Ports;
  readonly turn: RuntimeV2TurnIdentity;
  readonly run: RuntimeV2RunIdentity;
  readonly objective: string;
  readonly signal: AbortSignal;
  readonly initial?: RuntimeV2ControllerSnapshot;
  readonly now: () => number;
  readonly deadlineMs: number;
  readonly softIterationSignal?: number;
}

export interface RuntimeV2ChatLoopResult {
  readonly aggregate: TurnAggregateV1;
  readonly resultKind: RuntimeV2ResultKind;
  readonly reason: string;
}

interface DurableChatResponse {
  readonly visibleText: string;
  readonly hasToolCalls: boolean;
}

function latestDurableChatResponse(
  aggregate: TurnAggregateV1,
): DurableChatResponse | null {
  for (let index = aggregate.events.length - 1; index >= 0; index -= 1) {
    const event = aggregate.events[index]!;
    if (event.type !== "provider.responded") continue;
    return {
      visibleText: String(event.result.visibleText || "").trim().slice(0, 24_000),
      hasToolCalls: event.result.toolCalls.length > 0,
    };
  }
  return null;
}

function runStartedAt(aggregate: TurnAggregateV1, fallback: number): number {
  return aggregate.events.find((event) => event.type === "run.started")?.at ?? fallback;
}

/**
 * Provider-neutral, tool-free Chat strategy.
 *
 * A non-empty normalized provider response is a transport fact, not a prose
 * classifier. The loop never inspects the response wording to select a
 * lifecycle transition. Any tool call is a protocol violation and concludes
 * without invoking a Tool or Scheduler port.
 */
export async function runRuntimeV2ChatLoop(
  input: RuntimeV2ChatLoopInput,
): Promise<RuntimeV2ChatLoopResult> {
  const controller = new RuntimeV2Controller(
    input.ports,
    input.initial,
    { abortSignal: input.signal },
  );

  if (!input.initial) {
    await controller.admit({
      turn: input.turn,
      run: input.run,
      strategy: "chat",
      objective: input.objective,
      constraints: ["conversation_only", "no_tools", "no_side_effects"],
      acceptanceCriteria: ["one_visible_provider_reply"],
      initialPhase: "preparing",
    });
  }

  let aggregate = controller.snapshot().aggregate;
  if (!aggregate) throw new Error("RUNTIME_V2_CHAT_ADMISSION_MISSING");
  if (aggregate.terminalOutcome) {
    return {
      aggregate,
      resultKind: aggregate.terminalOutcome.resultKind,
      reason: aggregate.terminalOutcome.reason,
    };
  }

  const startedAt = runStartedAt(aggregate, input.now());
  const softIterationSignal = Math.max(1, input.softIterationSignal ?? 8);
  let iteration = 0;
  let softSignalRecorded = aggregate.events.some((event) =>
    event.type === "soft_signal.observed" && event.signal === "iteration_limit"
  );

  if (aggregate.scheduledCommands.length > 0) {
    await controller.resumeScheduled();
  }

  while (true) {
    aggregate = controller.snapshot().aggregate;
    if (!aggregate) throw new Error("RUNTIME_V2_CHAT_AGGREGATE_MISSING");
    if (aggregate.terminalOutcome) break;

    if (input.signal.aborted) {
      await controller.driveOnce();
      continue;
    }

    const response = latestDurableChatResponse(aggregate);
    if (response?.hasToolCalls) {
      await controller.driveOnce({
        resultKind: "error",
        resultReason: "只读对话通道收到了未授权的工具动作；未执行任何工具或工作区副作用。",
      });
      continue;
    }
    if (response?.visibleText) {
      await controller.driveOnce({
        resultKind: "success",
        resultReason: "只读对话回复已由当前 Turn 的唯一终态投影发布。",
        finalMarkdown: response.visibleText,
      });
      continue;
    }

    if (input.now() - startedAt >= input.deadlineMs) {
      await controller.driveOnce({
        resultKind: "partial",
        resultReason: "只读对话已达到本轮运行时限；没有执行任何工具或工作区副作用。",
      });
      continue;
    }

    if (aggregate.phase === "preparing") {
      await controller.changePhase(
        "observing",
        "已确认这是只读对话；正在基于当前会话上下文组织回复。",
      );
      continue;
    }

    if (iteration >= softIterationSignal && !softSignalRecorded) {
      await controller.recordSoftSignal("iteration_limit");
      softSignalRecorded = true;
    }
    iteration += 1;

    const drove = await controller.driveOnce();
    if (!drove && !controller.snapshot().aggregate?.terminalOutcome) {
      await controller.driveOnce({
        resultKind: "partial",
        resultReason: "只读对话没有产生可发布的结构化结果；本轮已明确收口。",
      });
    }
  }

  aggregate = controller.snapshot().aggregate;
  const terminal = aggregate?.terminalOutcome;
  if (!aggregate || !terminal) {
    throw new Error("RUNTIME_V2_CHAT_TERMINAL_MISSING");
  }
  return {
    aggregate,
    resultKind: terminal.resultKind,
    reason: terminal.reason,
  };
}
