import { sanitizeAIOutput, stripAnsi } from "./sanitize";
import { parseToolFeedbackEnvelope } from "./toolFeedbackEnvelope";

export type ToolResultPresentationLanguage = "zh" | "en";
export type ToolResultSectionTone = "default" | "error" | "muted";

export interface ToolResultSection {
  label: string;
  text: string;
  tone?: ToolResultSectionTone;
}

export interface ToolResultPresentation {
  kind: "terminal" | "text";
  command?: string;
  sections: ToolResultSection[];
  meta: string[];
  text: string;
  parsed: boolean;
}

const TERMINAL_TOOL_NAMES = new Set([
  "execute_command",
  "send_pty_input",
  "run_command",
  "read_pty_buffer",
  "read_pty_tail",
  "read_pty_since",
  "get_pty_status",
  "clear_pty_buffer",
]);

const JSON_LITERAL_ESCAPE_RE = /\\(?:r|n|t|u001b|u009b)/i;

export function isTerminalToolName(toolName: string): boolean {
  return TERMINAL_TOOL_NAMES.has(toolName);
}

function unwrapToolFeedbackEnvelope(text: string): string {
  const parsed = parseToolFeedbackEnvelope(text);
  return parsed ? parsed.body : text;
}

function normalizeTerminalText(value: unknown): string {
  return stripAnsi(String(value ?? ""))
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/\u0000/g, "")
    .trimEnd();
}

function decodeEscapedControlText(text: string): string {
  if (!JSON_LITERAL_ESCAPE_RE.test(text)) return text;
  return text
    .replace(/\\r\\n/g, "\n")
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "\n")
    .replace(/\\t/g, "\t")
    .replace(/\\u001b/gi, "\u001b")
    .replace(/\\u009b/gi, "\u009b");
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  if (!trimmed || (trimmed[0] !== "{" && trimmed[0] !== "[")) return null;
  try {
    const parsed = JSON.parse(trimmed);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function skipJsonWhitespace(source: string, index: number): number {
  let i = index;
  while (i < source.length && /\s/.test(source[i])) i += 1;
  return i;
}

function decodeJsonStringFrom(source: string, quoteIndex: number): string | null {
  if (source[quoteIndex] !== "\"") return null;
  let output = "";
  let i = quoteIndex + 1;

  while (i < source.length) {
    const char = source[i];
    if (char === "\"") return output;
    if (char !== "\\") {
      output += char;
      i += 1;
      continue;
    }

    i += 1;
    if (i >= source.length) break;
    const escaped = source[i];
    switch (escaped) {
      case "\"":
      case "\\":
      case "/":
        output += escaped;
        break;
      case "b":
        output += "\b";
        break;
      case "f":
        output += "\f";
        break;
      case "n":
        output += "\n";
        break;
      case "r":
        output += "\r";
        break;
      case "t":
        output += "\t";
        break;
      case "u": {
        const hex = source.slice(i + 1, i + 5);
        if (/^[0-9a-fA-F]{4}$/.test(hex)) {
          output += String.fromCharCode(parseInt(hex, 16));
          i += 4;
        } else {
          output += "\\u";
        }
        break;
      }
      default:
        output += escaped;
        break;
    }
    i += 1;
  }

  return output;
}

function extractJsonStringProperty(source: string, key: string): string | undefined {
  const keyToken = `"${key}"`;
  const keyIndex = source.indexOf(keyToken);
  if (keyIndex === -1) return undefined;
  const colonIndex = source.indexOf(":", keyIndex + keyToken.length);
  if (colonIndex === -1) return undefined;
  const valueIndex = skipJsonWhitespace(source, colonIndex + 1);
  if (source[valueIndex] !== "\"") return undefined;
  const decoded = decodeJsonStringFrom(source, valueIndex);
  return decoded == null ? undefined : decoded;
}

function extractJsonPrimitiveProperty(source: string, key: string): string | undefined {
  const keyToken = `"${key}"`;
  const keyIndex = source.indexOf(keyToken);
  if (keyIndex === -1) return undefined;
  const colonIndex = source.indexOf(":", keyIndex + keyToken.length);
  if (colonIndex === -1) return undefined;
  const valueIndex = skipJsonWhitespace(source, colonIndex + 1);
  const match = source.slice(valueIndex).match(/^-?(?:\d+(?:\.\d+)?|true|false|null)/);
  return match?.[0];
}

function readString(
  parsed: Record<string, unknown> | null,
  raw: string,
  keys: string[],
): string | undefined {
  for (const key of keys) {
    const parsedValue = parsed?.[key];
    if (typeof parsedValue === "string") return parsedValue;
    const extractedValue = extractJsonStringProperty(raw, key);
    if (typeof extractedValue === "string") return extractedValue;
  }
  return undefined;
}

function readNumber(parsed: Record<string, unknown> | null, raw: string, keys: string[]): number | undefined {
  for (const key of keys) {
    const parsedValue = parsed?.[key];
    if (typeof parsedValue === "number" && Number.isFinite(parsedValue)) return parsedValue;
    const extractedValue = extractJsonPrimitiveProperty(raw, key);
    if (extractedValue != null) {
      const numberValue = Number(extractedValue);
      if (Number.isFinite(numberValue)) return numberValue;
    }
  }
  return undefined;
}

function readBoolean(parsed: Record<string, unknown> | null, raw: string, keys: string[]): boolean | undefined {
  for (const key of keys) {
    const parsedValue = parsed?.[key];
    if (typeof parsedValue === "boolean") return parsedValue;
    const extractedValue = extractJsonPrimitiveProperty(raw, key);
    if (extractedValue === "true") return true;
    if (extractedValue === "false") return false;
  }
  return undefined;
}

function formatDuration(durationMs: number): string {
  if (durationMs >= 1000) {
    const seconds = durationMs / 1000;
    return `${seconds.toFixed(seconds >= 10 ? 0 : 1)}s`;
  }
  return `${Math.max(0, Math.round(durationMs))}ms`;
}

function compactMetaItems(items: Array<string | undefined>): string[] {
  return items
    .map((item) => String(item || "").trim())
    .filter(Boolean);
}

function buildStatusMeta(parsed: Record<string, unknown> | null, raw: string, language: ToolResultPresentationLanguage): string[] {
  const exitCode = readNumber(parsed, raw, ["exitCode", "exit_code", "code"]);
  const timedOut = readBoolean(parsed, raw, ["timedOut", "timed_out"]);
  const success = readBoolean(parsed, raw, ["success", "ok"]);
  const durationMs = readNumber(parsed, raw, ["durationMs", "duration_ms"]);
  const truncated =
    readBoolean(parsed, raw, ["truncated"]) ||
    readBoolean(parsed, raw, ["stdoutTruncated", "stdout_truncated"]) ||
    readBoolean(parsed, raw, ["stderrTruncated", "stderr_truncated"]);
  const startOffset = readNumber(parsed, raw, ["startOffset", "start_offset"]);
  const endOffset = readNumber(parsed, raw, ["endOffset", "end_offset"]);

  return compactMetaItems([
    typeof exitCode === "number" ? `exit ${exitCode}` : undefined,
    timedOut ? (language === "en" ? "timed out" : "已超时") : undefined,
    typeof exitCode !== "number" && success === false ? (language === "en" ? "failed" : "失败") : undefined,
    typeof durationMs === "number" ? formatDuration(durationMs) : undefined,
    truncated ? (language === "en" ? "truncated" : "已截断") : undefined,
    typeof startOffset === "number" && typeof endOffset === "number" ? `offset ${startOffset}-${endOffset}` : undefined,
  ]);
}

function pushSection(sections: ToolResultSection[], label: string, text: unknown, tone?: ToolResultSectionTone) {
  const normalized = normalizeTerminalText(text);
  if (!normalized.trim()) return;
  sections.push({ label, text: normalized, tone });
}

function buildTerminalPresentation(
  toolName: string,
  rawMessage: string,
  language: ToolResultPresentationLanguage,
): ToolResultPresentation {
  const raw = unwrapToolFeedbackEnvelope(rawMessage);
  const parsed = parseJsonObject(raw);
  const command = normalizeTerminalText(
    readString(parsed, raw, ["command"]) ||
      (toolName === "send_pty_input" ? readString(parsed, raw, ["input"]) : "") ||
      "",
  );
  const sections: ToolResultSection[] = [];

  if (toolName === "run_command") {
    pushSection(sections, "stdout", readString(parsed, raw, ["stdout"]));
    pushSection(sections, "stderr", readString(parsed, raw, ["stderr"]), "error");
  } else if (toolName === "get_pty_status") {
    const active = readBoolean(parsed, raw, ["active"]);
    const running = readBoolean(parsed, raw, ["running"]);
    const pid = readNumber(parsed, raw, ["pid"]);
    const tail = readString(parsed, raw, ["tail"]);
    const statusLine = compactMetaItems([
      active == null ? undefined : active ? "active" : "inactive",
      running == null ? undefined : running ? "running" : "stopped",
      typeof pid === "number" ? `pid ${pid}` : undefined,
    ]).join(" · ");
    pushSection(sections, language === "en" ? "Status" : "状态", statusLine, "muted");
    pushSection(sections, language === "en" ? "Tail" : "尾部输出", tail);
  } else {
    pushSection(
      sections,
      toolName === "send_pty_input" ? (language === "en" ? "New output" : "新增输出") : (language === "en" ? "Output" : "输出"),
      readString(parsed, raw, ["output", "text", "tail", "stdout"]),
    );
    pushSection(sections, "stderr", readString(parsed, raw, ["stderr"]), "error");
  }

  const parsedEnough = !!parsed || !!command || sections.length > 0;
  if (!parsedEnough) {
    const fallback = normalizeTerminalText(decodeEscapedControlText(raw));
    pushSection(sections, language === "en" ? "Output" : "输出", fallback);
  }

  const meta = buildStatusMeta(parsed, raw, language);
  const text = formatToolResultPresentationAsText({
    kind: "terminal",
    command: command || undefined,
    sections,
    meta,
    parsed: parsedEnough,
    text: "",
  });

  return {
    kind: "terminal",
    command: command || undefined,
    sections,
    meta,
    text,
    parsed: parsedEnough,
  };
}

export function buildToolResultPresentation(input: {
  toolName: string;
  message?: string;
  language?: ToolResultPresentationLanguage;
}): ToolResultPresentation {
  const language = input.language || "zh";
  const message = String(input.message || "");

  if (isTerminalToolName(input.toolName)) {
    return buildTerminalPresentation(input.toolName, message, language);
  }

  const text = sanitizeAIOutput(message);
  return {
    kind: "text",
    sections: text.trim() ? [{ label: "", text }] : [],
    meta: [],
    text,
    parsed: false,
  };
}

export function formatToolResultPresentationAsText(presentation: ToolResultPresentation): string {
  if (presentation.kind === "text") return presentation.text;

  const parts: string[] = [];
  if (presentation.command) parts.push(`$ ${presentation.command}`);
  for (const section of presentation.sections) {
    if (!section.text.trim()) continue;
    parts.push(section.label ? `${section.label}\n${section.text}` : section.text);
  }
  if (presentation.meta.length > 0) parts.push(presentation.meta.join(" · "));
  return parts.join("\n\n").trim();
}

