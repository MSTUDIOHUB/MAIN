import type { TurnAggregateV1 } from "./aggregate";
import type { RuntimeV2Event } from "./events";

type Response = Extract<RuntimeV2Event, { type: "provider.responded" }>;

export function stripResidueToolMarkup(
  text: string,
  options?: { concludeMode?: boolean } | boolean,
): string {
  const concludeMode =
    typeof options === "boolean" ? options : Boolean(options?.concludeMode);
  const codeBlocks: string[] = [];
  const placeholderPrefix = `__CODE_BLOCK_${Date.now()}_${Math.random().toString(36).slice(2, 8)}_`;
  let protectedText = text.replace(/(```[\s\S]*?```|`[^`\n]+`)/g, (match) => {
    const idx = codeBlocks.length;
    codeBlocks.push(match);
    return `${placeholderPrefix}${idx}__`;
  });

  const restorePlaceholders = (content: string): string => {
    let res = content;
    for (let i = 0; i < codeBlocks.length; i++) {
      res = res.split(`${placeholderPrefix}${i}__`).join(codeBlocks[i]);
    }
    return res;
  };

  const isJsonPayload = (content: string): boolean => {
    const restored = restorePlaceholders(content).trim();
    if (!restored) return false;
    const stripped = restored
      .replace(/<\/?(?:tool_call|function_call|tool_use|tool_code|runtime-v2-tools)(?:\s[^>]*)?>/gi, "")
      .trim();
    const unwrapped = (stripped || restored)
      .replace(/^```(?:json)?\s*([\s\S]*?)\s*```$/i, "$1")
      .trim();
    if (!unwrapped) return false;
    if (
      (unwrapped.startsWith("{") && unwrapped.endsWith("}")) ||
      (unwrapped.startsWith("[") && unwrapped.endsWith("]"))
    ) {
      try {
        const parsed = JSON.parse(unwrapped);
        return typeof parsed === "object" && parsed !== null;
      } catch {
        return false;
      }
    }
    return false;
  };

  const toolTagPattern =
    /<(tool_call|function_call|tool_use|tool_code|runtime-v2-tools)(?:\s[^>]*)?>([\s\S]*?)<\/\1>/gi;

  if (concludeMode) {
    protectedText = protectedText.replace(toolTagPattern, (_match, _tag, inner) => {
      if (isJsonPayload(inner)) {
        return "";
      }
      return inner;
    });
    const unclosedTrailingPattern =
      /<(?:tool_call|function_call|tool_use|tool_code|runtime-v2-tools)(?:\s[^>]*)?>([\s\S]*)$/gi;
    protectedText = protectedText.replace(unclosedTrailingPattern, (_match, inner) => {
      if (isJsonPayload(inner)) {
        return "";
      }
      return inner;
    });
  } else {
    protectedText = protectedText
      .replace(toolTagPattern, "")
      .replace(/<(?:tool_call|function_call|tool_use|tool_code|runtime-v2-tools)(?:\s[^>]*)?>[\s\S]*$/gi, "");
  }

  protectedText = protectedText
    .replace(/<\/?(?:tool_call|function_call|tool_use|tool_code|runtime-v2-tools)(?:\s[^>]*)?>/gi, "")
    .replace(/<\|(?:tool_call|begin_of_thought|end_of_thought)\|>?/gi, "")
    .replace(/<\|(?:start|end)_header_id\|>[^<]*<\|end_header_id\|>/gi, "");

  for (let i = 0; i < codeBlocks.length; i++) {
    protectedText = protectedText.split(`${placeholderPrefix}${i}__`).join(codeBlocks[i]);
  }

  return protectedText.trim();
}

/** Protocol and provenance eligibility, not a semantic quality oracle. A
 * verbatim replay of tool commentary provides no new user-facing answer. */
export function runtimeV2ProviderAnswerText(
  state: TurnAggregateV1,
  event: Response,
  isConclusion?: boolean,
): string {
  if (event.result.toolCalls.length) return "";
  if (event.result.diagnostics.some((d) => d.code === "output_truncated")) return "";
  const request = state.events.find((item) =>
    item.type === "command.scheduled" && item.command.idempotencyKey === event.idempotencyKey
  );
  const concludeMode = Boolean(
    isConclusion ||
    (request?.type === "command.scheduled" &&
      (request.command.payload.mode === "conclude" ||
        request.command.payload.conclusionKind === "read_only" ||
        (Array.isArray(request.command.payload.allowedToolNames) && request.command.payload.allowedToolNames.length === 0)))
  );
  if (event.result.diagnostics.length && !concludeMode) return "";
  let text = String(event.result.visibleText || "").trim();
  if (concludeMode || !event.result.diagnostics.length) {
    text = stripResidueToolMarkup(text, { concludeMode });
  }
  if (!text) return "";
  const reusedCommentary = state.events.some((previous) =>
    previous.sequence < event.sequence && previous.type === "provider.responded" &&
    previous.run.runId === event.run.runId && previous.result.toolCalls.length > 0 &&
    [previous.result.visibleText, previous.result.commentary].some((value) => String(value || "").trim() === text));
  return reusedCommentary ? "" : text;
}

/** Never look past newer work, a failed response, or an in-flight operation
 * to recycle a report authored for an earlier evidence boundary. */
export function latestRuntimeV2Answer(state: TurnAggregateV1, conclusionOnly = false): string {
  if (state.pendingToolCalls.length || state.scheduledCommands.length ||
    state.subagents?.some((job) => job.status === "queued" || job.status === "running")) return "";
  for (let i = state.events.length - 1; i >= 0; i -= 1) {
    const event = state.events[i]!;
    if (event.type === "tool.completed" || event.type === "validation.completed" || event.type === "run.started" ||
      event.type === "observation.recorded" || event.type === "subagent.completed" || event.type === "subagent.handoff_delivered" || event.type === "subagent.handoff_applied" ||
      (event.type === "command.scheduled" && event.command.kind === "request_model")) return "";
    if (event.type !== "provider.responded") continue;
    if (state.run && event.run.runId !== state.run.identity.runId) return "";
    const request = state.events.find((item) => item.type === "command.scheduled" && item.command.idempotencyKey === event.idempotencyKey);
    const isConclude = request?.type === "command.scheduled" &&
      (request.command.payload.mode === "conclude" ||
        request.command.payload.conclusionKind === "read_only" ||
        (Array.isArray(request.command.payload.allowedToolNames) && request.command.payload.allowedToolNames.length === 0));
    if (conclusionOnly && (request?.type !== "command.scheduled" || (request.command.payload.mode !== "conclude" && !isConclude))) return "";
    return runtimeV2ProviderAnswerText(state, event, conclusionOnly || isConclude);
  }
  return "";
}
