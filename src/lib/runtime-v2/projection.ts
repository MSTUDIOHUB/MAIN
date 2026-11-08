import type { TurnAggregateV1 } from "./aggregate";
import type {
  RuntimeV2Command,
  RuntimeV2Projection,
  RuntimeV2ProjectionAudience,
  RuntimeV2ResultKind,
} from "./contracts";
import type { RuntimeV2Event } from "./events";
import { countDistinctRuntimeV2EvidenceFacts } from "./evidenceFacts";
import { isRuntimeV2ValidationAttempt } from "./validationAttempt";

function markdownCode(value: unknown): string {
  const text = String(value || "").trim().replace(/`/g, "");
  return text ? `\`${text}\`` : "当前工作区";
}

function workspaceRelativeTarget(value: unknown, workspaceKey = ""): string {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const normalized = raw.replace(/\\/g, "/");
  const workspace = workspaceKey.replace(/\\/g, "/").replace(/\/+$/, "");
  if (workspace && normalized.startsWith(`${workspace}/`)) {
    return normalized.slice(workspace.length + 1);
  }
  if (/^\//.test(normalized)) {
    const sourceSuffix = normalized.match(
      /(?:^|\/)((?:src-tauri|src|tests?|scripts?|packages?|apps?|lib)\/.+)$/,
    )?.[1];
    return sourceSuffix || normalized.split("/").filter(Boolean).pop() || raw;
  }
  return raw;
}

function readTarget(command: RuntimeV2Command, workspaceKey = ""): string {
  const args = command.payload.arguments;
  const record = args && typeof args === "object" && !Array.isArray(args)
    ? args as Record<string, unknown>
    : {};
  return markdownCode(workspaceRelativeTarget(
    record.path || record.file || record.query || command.payload.target,
    workspaceKey,
  ));
}

export function runtimeV2StructuredActionMarkdown(
  command: RuntimeV2Command,
  context?: Pick<TurnAggregateV1, "strategy" | "turn">,
): string {
  switch (command.kind) {
    case "collect_observation":
      return "正在收集与当前目标相关的上下文与证据。";
    case "request_model":
      return "正在准备模型请求。";
    case "execute_tool": {
      const tool = String(command.payload.toolName || "").trim();
      const target = readTarget(command, context?.turn.workspaceKey);
      if (tool === "web_search") return `正在联网搜索 ${target}，获取最新信息。`;
      if (tool === "web_fetch") return `正在抓取网页 ${target} 的详细内容。`;
      if (/read|open|outline/i.test(tool)) return `正在读取 ${target}，确认与当前问题相关的上下文与实现。`;
      if (/search|grep|glob|find/i.test(tool)) return `正在搜索 ${target}，收窄需要检查的范围。`;
      if (/patch|replace|write|edit/i.test(tool)) return `正在修改 ${target}，落实已经确认的方案。`;
      if (/command|shell|run|test|build/i.test(tool)) return `正在运行 ${target}，验证最新修改是否符合预期。`;
      return `正在执行 ${markdownCode(tool || "当前工具")}：${target}`;
    }
    case "execute_validation":
      return "正在运行有限验证，检查本轮修改和验收条件。";
    case "schedule_subagents":
      return "正在启动范围明确的子智能体协作，主体会继续处理不依赖这些证据或暂存修改的工作。";
    case "join_subagents":
      return "正在汇合子智能体的调查结果，并把可信证据纳入当前判断。";
    case "publish_projection":
      return "正在同步最新任务状态。";
    case "finalize_turn":
      return context?.strategy === "chat" || context?.strategy === "analyze"
        ? "正在整理本轮对话的完整回复。"
        : "正在整理已验证的结果与仍需说明的边界。";
  }
}

function visibleProviderCommentary(
  result: Extract<
    RuntimeV2Event,
    { type: "provider.responded" }
  >["result"],
): string {
  const commentary = String(
    result.commentary || result.visibleText || "",
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
  if (/```|<tool(?:_use)?>|<runtime-v2-tools>/i.test(commentary)) return "";
  const compact = commentary.replace(/\s+/g, " ").trim();
  if (compact.length <= 180) return compact;
  const completeSentences = compact.match(/[^。！？!?]+[。！？!?]+/g) || [];
  let selected = "";
  for (const sentence of completeSentences) {
    if (`${selected}${sentence}`.length > 180) break;
    selected += sentence;
    if (selected.length >= 80) break;
  }
  // Never cut a provider sentence in half or append synthetic ellipses. When
  // no concise complete public sentence exists, the structured action below
  // is more truthful than a clipped fragment.
  return selected.trim();
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

/** Durable phase projection for older consumers. The live UI reads the
 * actual request and tool activity, while public commentary goes to ChatArea. */
export function buildRuntimeV2CapsuleProjection(
  aggregate: TurnAggregateV1,
  id: string,
): RuntimeV2Projection {
  const current = aggregate.scheduledCommands[0];
  const markdown = current
    ? runtimeV2StructuredActionMarkdown(current, aggregate)
    : `正在${phaseTitle(aggregate.phase)}。`;
  return projection(
    aggregate,
    "capsule_live",
    id,
    markdown,
    "live_action",
    current ? `action:${current.idempotencyKey}` : `phase:${aggregate.phase}:${aggregate.updatedAt}`,
  );
}

/**
 * Durable ChatArea update sourced only from provider-authored public
 * commentary attached to a real structured action. Phase changes, child
 * scheduling and evidence counts remain structured UI state; Runtime must not
 * impersonate the model with prewritten assistant messages.
 */
export function buildRuntimeV2MilestoneProjection(
  aggregate: TurnAggregateV1,
  event: RuntimeV2Event,
  id: string,
): RuntimeV2Projection | null {
  if (event.type !== "provider.responded") return null;
  if (event.result.toolCalls.length === 0) return null;
  const commentary = visibleProviderCommentary(event.result);
  if (!commentary) return null;
  return projection(
    aggregate,
    "chat_milestone",
    id,
    commentary,
    "milestone",
    `provider-commentary:${event.idempotencyKey}`,
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
    runtimeV2StructuredActionMarkdown(command, aggregate),
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
  if (aggregate.strategy === "chat" || aggregate.strategy === "analyze" || (aggregate.strategy === "plan" && !aggregate.sealedWorkPlan)) {
    return projection(
      aggregate,
      "final",
      id,
      finalMarkdown?.trim() || `### ${terminalTitle(resultKind)}\n\n${reason}`,
      "final",
      `final:${resultKind}:${reason}`,
    );
  }
  const mutationTargets = [...new Set(aggregate.evidence
    .filter((evidence) => evidence.kind === "mutation")
    .map((evidence) => evidence.target)
    .filter(Boolean))];
  const validations = aggregate.events.filter(
    isRuntimeV2ValidationAttempt,
  );
  const passedValidations = validations.filter((event) => event.passed).length;
  const failedValidations = validations.length - passedValidations;
  const evidenceCount = countDistinctRuntimeV2EvidenceFacts(
    aggregate.evidence,
  );
  const evidenceLine = evidenceCount > 0
    ? `- 已保留 ${evidenceCount} 条证据。`
    : "- 本轮没有可保留的证据。";
  const mutationLine = mutationTargets.length > 0
    ? `- 已修改：${mutationTargets.map(markdownCode).join("、")}。`
    : "- 本轮没有已提交的文件修改。";
  const validationLine = validations.length > 0
    ? `- 验证结果：${passedValidations} 次通过，${failedValidations} 次未通过。`
    : "- 本轮没有完成可确认的验证。";
  return projection(
    aggregate,
    "final",
    id,
    [
      `### ${terminalTitle(resultKind)}`,
      finalMarkdown?.trim(),
      mutationLine,
      validationLine,
      evidenceLine,
      /^[a-z][a-z0-9_:-]*$/.test(reason) ? "" : `- ${reason}`,
    ].filter(Boolean).join("\n\n"),
    "final",
    `final:${resultKind}:${reason}`,
  );
}
