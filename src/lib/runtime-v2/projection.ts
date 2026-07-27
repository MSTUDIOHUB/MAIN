import type { TurnAggregateV1 } from "./aggregate";
import type {
  RuntimeV2Command,
  RuntimeV2Projection,
  RuntimeV2ProjectionAudience,
  RuntimeV2ResultKind,
} from "./contracts";
import type { RuntimeV2Event } from "./events";

function markdownCode(value: unknown): string {
  const text = String(value || "").trim().replace(/`/g, "");
  return text ? `\`${text}\`` : "当前工作区";
}

function readTarget(command: RuntimeV2Command): string {
  const args = command.payload.arguments;
  const record = args && typeof args === "object" && !Array.isArray(args)
    ? args as Record<string, unknown>
    : {};
  return markdownCode(record.path || record.file || record.query || command.payload.target);
}

function actionMarkdown(
  command: RuntimeV2Command,
  strategy?: TurnAggregateV1["strategy"],
): string {
  switch (command.kind) {
    case "collect_observation":
      return `正在收集与当前目标相关的代码证据：${String(command.payload.objective || "").trim()}`;
    case "request_model": {
      const mode = String(command.payload.mode || "");
      const labels: Record<string, string> = {
        chat: "正在理解当前问题，并结合本轮对话上下文组织完整回复。",
        analyze: "正在结合工作区的实际只读证据形成完整答复。",
        observe: "正在根据已读证据判断根本原因。",
        plan: "正在把已确认的事实整理成可审核的修复计划。",
        execute: "正在依据已批准的计划决定下一项安全修改或验证。",
        validate: "正在根据验收条件检查当前实现。",
      };
      return labels[mode] || "正在根据当前证据决定下一步。";
    }
    case "execute_tool": {
      const tool = String(command.payload.toolName || "").trim();
      const target = readTarget(command);
      if (/read|open|outline/i.test(tool)) return `正在读取 ${target}，确认与当前问题相关的实现。`;
      if (/search|grep|glob|find/i.test(tool)) return `正在搜索 ${target}，收窄需要检查的代码范围。`;
      if (/patch|replace|write|edit/i.test(tool)) return `正在修改 ${target}，落实已经确认的修复方案。`;
      if (/command|shell|run|test|build/i.test(tool)) return `正在运行 ${target}，验证最新修改是否符合预期。`;
      return `正在执行 ${markdownCode(tool || "当前工具")}：${target}`;
    }
    case "execute_validation":
      return "正在运行有限验证，检查本轮修改和验收条件。";
    case "schedule_subagents":
      return "正在为互不重叠的只读范围启动子智能体，主体会继续处理不依赖这些结果的工作。";
    case "join_subagents":
      return "正在汇合子智能体的调查结果，并把可信证据纳入当前判断。";
    case "publish_projection":
      return "正在同步最新任务状态。";
    case "finalize_turn":
      return strategy === "chat"
        ? "正在整理本轮对话的完整回复。"
        : "正在整理已验证的结果与仍需说明的边界。";
  }
}

function publicProviderCommentaryForCommand(
  aggregate: TurnAggregateV1,
  command: RuntimeV2Command | undefined,
): string {
  if (!command) return "";
  const toolCallId = String(command.payload.toolCallId || "").trim();
  if (!toolCallId) return "";
  const response = [...aggregate.events].reverse().find((event) =>
    event.type === "provider.responded" &&
    event.result.toolCalls.some((call) => call.id === toolCallId)
  );
  if (!response || response.type !== "provider.responded") return "";
  const commentary = String(
    response.result.commentary || response.result.visibleText || "",
  ).trim();
  // A text-envelope transport is an implementation detail, not user-facing
  // commentary. It may schedule the command, but its JSON must never leak into
  // Capsule.
  if (
    !commentary ||
    /^<runtime-v2-tools>[\s\S]*<\/runtime-v2-tools>$/i.test(commentary)
  ) {
    return "";
  }
  return commentary;
}

function phaseTitle(phase: TurnAggregateV1["phase"]): string {
  const labels: Record<TurnAggregateV1["phase"], string> = {
    preparing: "准备执行",
    observing: "收集证据",
    planning: "形成计划",
    reviewing: "等待审核",
    acting: "实施修改",
    validating: "验证结果",
    finalizing: "整理结论",
    completed: "任务结束",
  };
  return labels[phase];
}

function terminalTitle(resultKind: RuntimeV2ResultKind): string {
  const labels: Record<RuntimeV2ResultKind, string> = {
    success: "已完成",
    partial: "已部分完成",
    blocked: "需要继续处理",
    error: "执行遇到错误",
    canceled: "已取消",
  };
  return labels[resultKind];
}

function projection(
  aggregate: TurnAggregateV1,
  audience: RuntimeV2ProjectionAudience,
  id: string,
  markdown: string,
  kind: RuntimeV2Projection["kind"],
  dedupeKey: string,
): RuntimeV2Projection {
  return {
    id,
    audience,
    markdown: markdown.trim(),
    kind,
    dedupeKey: `${aggregate.turn.turnId}:${dedupeKey}`,
  };
}

/** Full visible action text for Capsule. It intentionally does not truncate. */
export function buildRuntimeV2CapsuleProjection(
  aggregate: TurnAggregateV1,
  id: string,
): RuntimeV2Projection {
  const current = aggregate.scheduledCommands[0];
  const latestProviderCommentary = [...aggregate.events].reverse().find((event) =>
    event.type === "provider.responded" && !!event.result.commentary
  );
  const action = current
    ? actionMarkdown(current, aggregate.strategy)
    : latestProviderCommentary?.type === "provider.responded"
      ? latestProviderCommentary.result.commentary || "正在等待下一项结构化动作。"
      : `正在${phaseTitle(aggregate.phase)}。`;
  const commandCommentary = publicProviderCommentaryForCommand(
    aggregate,
    current,
  );
  const markdown = commandCommentary && commandCommentary !== action
    ? `${commandCommentary}\n\n${action}`
    : action;
  return projection(
    aggregate,
    "capsule_live",
    id,
    markdown,
    "live_action",
    current ? `action:${current.idempotencyKey}` : `phase:${aggregate.phase}:${aggregate.updatedAt}`,
  );
}

/** Durable ChatArea checkpoint, emitted only at a structured phase/evidence boundary. */
export function buildRuntimeV2MilestoneProjection(
  aggregate: TurnAggregateV1,
  event: RuntimeV2Event,
  id: string,
): RuntimeV2Projection | null {
  if (
    event.type !== "phase.changed" &&
    event.type !== "observation.recorded" &&
    event.type !== "work_plan.sealed" &&
    event.type !== "subagents.scheduled" &&
    event.type !== "subagent.completed"
  ) {
    return null;
  }
  if (event.type === "observation.recorded") {
    return projection(
      aggregate,
      "chat_milestone",
      id,
      `### 已确认一条新的证据\n\n- 已记录 ${markdownCode(event.evidence.target)} 的观察结果。`,
      "milestone",
      `evidence:${event.evidence.id}`,
    );
  }
  if (event.type === "work_plan.sealed") {
    return projection(
      aggregate,
      "chat_milestone",
      id,
      `### 修复计划已准备好\n\n- 已绑定 ${aggregate.evidence.length} 条证据。\n- 正在等待审核后再开始修改。`,
      "milestone",
      `plan:${event.workPlan.digest}`,
    );
  }
  if (event.type === "subagents.scheduled") {
    return projection(
      aggregate,
      "chat_milestone",
      id,
      [
        "### 已启动并行只读调查",
        "",
        ...event.jobs.map((job) => `- 已将 \`${job.scopeKey}\` 分配给独立子智能体（范围：${job.allowedPaths.map(markdownCode).join("、")}）。`),
        "- 我会继续处理不依赖这些结果的工作，随后统一汇合可信证据。",
      ].join("\n"),
      "milestone",
      `subagents:${event.jobs.map((job) => job.id).join(":")}`,
    );
  }
  if (event.type === "subagent.completed") {
    return projection(
      aggregate,
      "chat_milestone",
      id,
      `### 子智能体已返回调查结果\n\n- 已完成 \`${event.jobId}\` 的只读范围调查，并记录 ${event.evidence.length} 条可用证据。`,
      "milestone",
      `subagent:${event.jobId}:${event.status}`,
    );
  }
  return projection(
    aggregate,
    "chat_milestone",
    id,
    aggregate.strategy === "chat"
      ? `### 正在组织回复\n\n- 已确认本轮只进行对话，不会调用工具或修改工作区。\n- ${event.reason}`
      : `### 当前阶段：${phaseTitle(event.phase)}\n\n- 已保留 ${aggregate.evidence.length} 条可信证据。\n- ${event.reason}`,
    "milestone",
    `phase:${event.phase}:${event.sequence}`,
  );
}

export function buildRuntimeV2TimelineProjection(
  aggregate: TurnAggregateV1,
  command: RuntimeV2Command,
  id: string,
): RuntimeV2Projection {
  return projection(
    aggregate,
    "timeline",
    id,
    actionMarkdown(command, aggregate.strategy),
    "timeline",
    `command:${command.idempotencyKey}`,
  );
}

export function buildRuntimeV2FinalProjection(
  aggregate: TurnAggregateV1,
  id: string,
  resultKind: RuntimeV2ResultKind,
  reason: string,
  finalMarkdown?: string,
): RuntimeV2Projection {
  if (aggregate.strategy === "chat") {
    return projection(
      aggregate,
      "final",
      id,
      finalMarkdown?.trim() || `### ${terminalTitle(resultKind)}\n\n${reason}`,
      "final",
      `final:${resultKind}:${reason}`,
    );
  }
  const evidenceLine = aggregate.evidence.length > 0
    ? `- 已保留 ${aggregate.evidence.length} 条证据。`
    : "- 本轮没有可保留的证据。";
  return projection(
    aggregate,
    "final",
    id,
    [
      `### ${terminalTitle(resultKind)}`,
      finalMarkdown?.trim(),
      evidenceLine,
      `- ${reason}`,
    ].filter(Boolean).join("\n\n"),
    "final",
    `final:${resultKind}:${reason}`,
  );
}
