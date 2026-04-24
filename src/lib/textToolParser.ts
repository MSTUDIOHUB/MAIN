// lib/textToolParser.ts
// Parses model text output for XML-based tool calls and reasoning.
//
// Handles multiple formats that local models may produce:
//   1. <tool_use> with nested <tool> and <parameter> tags
//   2. <tool_call> with JSON inside
//   3. <function_call> with JSON inside
//
// Reasoning tags extracted as thoughts:
//   <analysis>, <thought>, <thinking>, <reasoning>
// ────────────────────────────────────────────────────────────────────

export interface ParsedToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ParsedTextResult {
  reasoning: string | null;
  toolCalls: ParsedToolCall[];
  cleanText: string;
}

let callIdCounter = 0;
function nextCallId(): string {
  return `text_call_${++callIdCounter}`;
}

const BARE_TOOL_NAMES = new Set([
  "get_project_skeleton",
  "get_file_outline",
  "list_directory",
  "read_file",
  "read_document",
  "analyze_tabular_document",
  "query_tabular_document",
  "index_workspace_documents",
  "glob_search",
  "grep_search",
  "replace_in_file",
  "write_file",
  "execute_command",
  "send_pty_input",
  "run_command",
  "read_pty_buffer",
  "read_pty_tail",
  "read_pty_since",
  "get_pty_status",
  "clear_pty_buffer",
]);

const TOOL_BODY_ARG_NAMES: Partial<Record<string, string>> = {
  execute_command: "command",
  send_pty_input: "input",
  run_command: "command",
  write_file: "content",
};

function extractMatches(text: string, regex: RegExp): string[] {
  const results: string[] = [];
  const re = new RegExp(regex.source, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    results.push(m[1]);
  }
  return results;
}

function parseToolUseBlock(inner: string): ParsedToolCall[] {
  const calls: ParsedToolCall[] = [];
  const parts = inner.split(/<tool>/).filter((p) => p.trim());

  for (const part of parts) {
    const nameMatch = part.match(/^([\s\S]*?)<\/tool>/);
    if (!nameMatch) continue;
    const name = nameMatch[1].trim();
    if (!name) continue;

    const args: Record<string, unknown> = {};
    const paramRe = /<parameter\s+name=["']([^"']+)["']>([\s\S]*?)<\/parameter>/g;
    let pm: RegExpExecArray | null;
    while ((pm = paramRe.exec(part)) !== null) {
      args[pm[1]] = pm[2].trim();
    }

    calls.push({ id: nextCallId(), name, arguments: args });
  }

  return calls;
}

function parseJsonToolCall(jsonStr: string): ParsedToolCall | null {
  try {
    const parsed = JSON.parse(jsonStr.trim());
    if (!parsed || typeof parsed.name !== "string") return null;
    return {
      id: nextCallId(),
      name: parsed.name,
      arguments: parsed.arguments ?? {},
    };
  } catch {
    return null;
  }
}

function normalizeInlineArgValue(value: string): unknown {
  const trimmed = value.trim();
  if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) return Number(trimmed);
  if (/^(?:true|false)$/i.test(trimmed)) return trimmed.toLowerCase() === "true";
  return trimmed;
}

function parseNamedArguments(text: string): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  const attrRe = /([a-z_][a-z0-9_]*)=(?:"([^"]*)"|'([^']*)'|(\S+))/gi;
  let match: RegExpExecArray | null;

  while ((match = attrRe.exec(text)) !== null) {
    const [, key, dq, sq, bare] = match;
    const rawValue = dq ?? sq ?? bare ?? "";
    args[key] = normalizeInlineArgValue(rawValue);
  }

  return args;
}

function parseInlineToolInvocation(text: string): ParsedToolCall | null {
  const trimmed = text.trim();
  if (!trimmed) return null;

  const match = trimmed.match(/^([a-z_][a-z0-9_]*)(?:\s+([\s\S]*))?$/i);
  if (!match) return null;

  const toolName = match[1];
  if (!BARE_TOOL_NAMES.has(toolName)) return null;

  const rest = (match[2] || "").trim();
  if (!rest) {
    return {
      id: nextCallId(),
      name: toolName,
      arguments: {},
    };
  }

  const args = parseNamedArguments(rest);
  if (Object.keys(args).length > 0) {
    return {
      id: nextCallId(),
      name: toolName,
      arguments: args,
    };
  }

  if (toolName === "get_project_skeleton" && /^\d+$/.test(rest)) {
    return {
      id: nextCallId(),
      name: toolName,
      arguments: { depth: Number(rest) },
    };
  }

  if (toolName === "execute_command" || toolName === "run_command") {
    return {
      id: nextCallId(),
      name: toolName,
      arguments: { command: rest },
    };
  }

  return null;
}

function parseLegacyToolTags(text: string): { toolCalls: ParsedToolCall[]; cleanText: string } {
  const toolCalls: ParsedToolCall[] = [];

  const cleanText = text
    .replace(/<([a-z_][a-z0-9_]*)(\s[^>]*)?\/>/gi, (full, rawTagName: string, rawAttrs = "") => {
      const tagName = rawTagName.trim();
      if (!BARE_TOOL_NAMES.has(tagName)) return full;

      const args = parseNamedArguments(rawAttrs);
      toolCalls.push({
        id: nextCallId(),
        name: tagName,
        arguments: args,
      });
      return "";
    })
    .replace(/<([a-z_][a-z0-9_]*)(\s[^>]*)?>([\s\S]*?)<\/\1>/gi, (full, rawTagName: string, rawAttrs = "", rawBody = "") => {
      const tagName = rawTagName.trim();
      if (!BARE_TOOL_NAMES.has(tagName)) return full;

      const body = String(rawBody || "").trim();
      const args = parseNamedArguments(rawAttrs);

      if (body) {
        if (tagName === "execute_command") {
          const nestedCall = parseInlineToolInvocation(body);
          if (nestedCall && nestedCall.name !== "execute_command") {
            toolCalls.push(nestedCall);
            return "";
          }
          if (!("command" in args)) {
            args.command = body;
          }
        } else {
          const bodyArgName = TOOL_BODY_ARG_NAMES[tagName];
          if (bodyArgName && !(bodyArgName in args)) {
            args[bodyArgName] = body;
          } else if (Object.keys(args).length === 0) {
            const bodyArgs = parseNamedArguments(body);
            if (Object.keys(bodyArgs).length > 0) {
              Object.assign(args, bodyArgs);
            }
          }
          if (tagName === "get_project_skeleton" && !("depth" in args) && /^\d+$/.test(body)) {
            args.depth = Number(body);
          }
        }
      }

      toolCalls.push({
        id: nextCallId(),
        name: tagName,
        arguments: args,
      });
      return "";
    })
    .trim();

  return { toolCalls, cleanText };
}

function parseBareToolCalls(text: string): { toolCalls: ParsedToolCall[]; cleanText: string } {
  const lines = text.split(/\r?\n/);
  const toolCalls: ParsedToolCall[] = [];
  const keep: string[] = [];

  let i = 0;
  while (i < lines.length) {
    const rawLine = lines[i];
    const trimmed = rawLine.trim();

    const inlineCall = parseInlineToolInvocation(trimmed);
    if (inlineCall) {
      toolCalls.push(inlineCall);
      i += 1;
      continue;
    }

    if (BARE_TOOL_NAMES.has(trimmed)) {
      const next = lines[i + 1]?.trim() || "";
      if (next.startsWith("{") && next.endsWith("}")) {
        try {
          const parsed = JSON.parse(next);
          toolCalls.push({
            id: nextCallId(),
            name: trimmed,
            arguments: parsed,
          });
          i += 2;
          continue;
        } catch {
          // fall through
        }
      }

      if (trimmed === "get_project_skeleton" && /^\d+$/.test(next)) {
        toolCalls.push({
          id: nextCallId(),
          name: trimmed,
          arguments: { depth: Number(next) },
        });
        i += 2;
        continue;
      }
    }

    keep.push(rawLine);
    i += 1;
  }

  return {
    toolCalls,
    cleanText: keep.join("\n").trim(),
  };
}

export function parseTextForTools(text: string): ParsedTextResult {
  // 1. Extract reasoning from analysis/thought/thinking/reasoning tags
  let reasoning: string | null = null;
  const reasoningParts = extractMatches(
    text,
    /<(?:analysis|thought|thinking|reasoning)(?:\s[^>]*)?>([\s\S]*?)<\/(?:analysis|thought|thinking|reasoning)>/,
  );
  if (reasoningParts.length > 0) {
    reasoning = reasoningParts.map((r) => r.trim()).join("\n");
  }

  // 2. Extract tool calls
  const toolCalls: ParsedToolCall[] = [];

  // Format 1: <tool_use> blocks
  const toolUseBlocks = extractMatches(text, /<tool_use>([\s\S]*?)<\/tool_use>/);
  for (const block of toolUseBlocks) {
    toolCalls.push(...parseToolUseBlock(block));
  }

  // Format 2+3: tool_call / function_call blocks with JSON
  const jsonBlocks = extractMatches(
    text,
    /<(?:tool_call|function_call)(?:\s[^>]*)?>([\s\S]*?)<\/(?:tool_call|function_call)>/,
  );
  for (const block of jsonBlocks) {
    const parsed = parseJsonToolCall(block);
    if (parsed) toolCalls.push(parsed);
  }

  // 3. Build clean text by removing all known XML blocks
  const xmlStrippedText = text
    .replace(
      /<(?:analysis|thought|thinking|reasoning)(?:\s[^>]*)?>[\s\S]*?<\/(?:analysis|thought|thinking|reasoning)>/g,
      "",
    )
    .replace(/<tool_use>[\s\S]*?<\/tool_use>/g, "")
    .replace(
      /<(?:tool_call|function_call)(?:\s[^>]*)?>[\s\S]*?<\/(?:tool_call|function_call)>/g,
      "",
    )
    .replace(
      /<\/?(?:analysis|thought|thinking|reasoning|tool_use|tool_call|function_call|tool|parameter|tool_response)(?:\s[^>]*)?>/g,
      "",
    )
    .trim();

  const legacyParsed = parseLegacyToolTags(xmlStrippedText);
  toolCalls.push(...legacyParsed.toolCalls);

  const bareParsed = parseBareToolCalls(legacyParsed.cleanText);
  toolCalls.push(...bareParsed.toolCalls);
  const cleanText = bareParsed.cleanText;

  return { reasoning, toolCalls, cleanText };
}
