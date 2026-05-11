export const TOOL_FEEDBACK_ENVELOPE_PREFIX = "[MAIN_TOOL_FEEDBACK_V1]";

export type ToolFeedbackStatus =
  | "completed"
  | "failed"
  | "declined"
  | "blocked"
  | "cached"
  | "no_op";

export interface ToolFeedbackEnvelopeV1 {
  version: 1;
  status: ToolFeedbackStatus;
  tool_call_id: string;
  tool: string;
  target: string;
  truncated?: boolean;
  summary?: string;
  hints?: string[];
}

export interface BuildToolFeedbackEnvelopeInput {
  status: ToolFeedbackStatus;
  toolCallId: string;
  tool: string;
  target: string;
  content: string;
  truncated?: boolean;
  summary?: string;
  hints?: string[];
}

function compactLine(value: unknown, maxChars: number): string {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  if (!text) return "";
  return text.length <= maxChars ? text : `${text.slice(0, maxChars).trim()}...`;
}

export function buildToolFeedbackEnvelope(input: BuildToolFeedbackEnvelopeInput): ToolFeedbackEnvelopeV1 {
  const summary = compactLine(input.summary || input.content, 180);
  const hints = (input.hints || []).map((hint) => compactLine(hint, 180)).filter(Boolean);
  return {
    version: 1,
    status: input.status,
    tool_call_id: String(input.toolCallId || ""),
    tool: compactLine(input.tool, 80),
    target: compactLine(input.target, 180),
    ...(input.truncated ? { truncated: true } : {}),
    ...(summary ? { summary } : {}),
    ...(hints.length > 0 ? { hints } : {}),
  };
}

export function formatToolFeedbackEnvelope(input: BuildToolFeedbackEnvelopeInput): string {
  const envelope = buildToolFeedbackEnvelope(input);
  const body = String(input.content ?? "").trim();
  return `${TOOL_FEEDBACK_ENVELOPE_PREFIX}${JSON.stringify(envelope)}\n${body}`;
}

export function parseToolFeedbackEnvelope(text: string): { envelope: ToolFeedbackEnvelopeV1; body: string } | null {
  const source = String(text || "");
  if (!source.startsWith(TOOL_FEEDBACK_ENVELOPE_PREFIX)) return null;
  const payload = source.slice(TOOL_FEEDBACK_ENVELOPE_PREFIX.length);
  const newlineIdx = payload.indexOf("\n");
  const headerText = (newlineIdx >= 0 ? payload.slice(0, newlineIdx) : payload).trim();
  const body = newlineIdx >= 0 ? payload.slice(newlineIdx + 1) : "";
  if (!headerText) return null;

  try {
    const parsed = JSON.parse(headerText) as Partial<ToolFeedbackEnvelopeV1>;
    if (!parsed || parsed.version !== 1 || typeof parsed.status !== "string") return null;
    if (typeof parsed.tool_call_id !== "string") return null;
    if (typeof parsed.tool !== "string") return null;
    if (typeof parsed.target !== "string") return null;
    return {
      envelope: {
        version: 1,
        status: parsed.status as ToolFeedbackStatus,
        tool_call_id: parsed.tool_call_id,
        tool: parsed.tool,
        target: parsed.target,
        ...(parsed.truncated ? { truncated: true } : {}),
        ...(typeof parsed.summary === "string" ? { summary: parsed.summary } : {}),
        ...(Array.isArray(parsed.hints) ? { hints: parsed.hints.filter((hint): hint is string => typeof hint === "string") } : {}),
      },
      body,
    };
  } catch {
    return null;
  }
}
