// lib/textToolParser.ts
// Parses model text output for XML-based tool calls and reasoning.
//
// Handles multiple formats that local models may produce:
//   1. <tool_use> with nested <tool> and <parameter> tags
//   2. <tool_call> with JSON inside
//   3. <function_call> with JSON inside
//   4. <tool_code> wrappers containing a single function-style call
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

const TOOL_POSITIONAL_ARG_NAMES: Partial<Record<string, string>> = {
  get_file_outline: "path",
  list_directory: "path",
  read_file: "path",
  read_document: "path",
  analyze_tabular_document: "path",
  query_tabular_document: "path",
  index_workspace_documents: "path",
  glob_search: "pattern",
  grep_search: "query",
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
  const paramRe = /<parameter\s+name=["']([^"']+)["']>([\s\S]*?)<\/parameter>/gi;
  const parseArgs = (part: string): Record<string, unknown> => {
    const args: Record<string, unknown> = {};
    let pm: RegExpExecArray | null;
    paramRe.lastIndex = 0;
    while ((pm = paramRe.exec(part)) !== null) {
      const key = String(pm[1] || "").trim();
      if (!key) continue;
      args[key] = pm[2].trim();
    }
    return args;
  };
  const stripToolNameRecoveryFields = (args: Record<string, unknown>): Record<string, unknown> => {
    delete args.tool;
    delete args.name;
    delete args.function;
    return args;
  };

  const parts = inner.split(/<tool>/i).filter((p) => p.trim());

  for (const part of parts) {
    const nameMatch = part.match(/^([\s\S]*?)<\/tool>/i);
    if (!nameMatch) continue;
    const name = nameMatch[1].trim();
    if (!BARE_TOOL_NAMES.has(name)) continue;

    const args = stripToolNameRecoveryFields(parseArgs(part));
    calls.push({ id: nextCallId(), name, arguments: args });
  }

  if (calls.length > 0) return calls;

  const fallbackArgs = parseArgs(inner);
  const fallbackToolValue = fallbackArgs.tool ?? fallbackArgs.name ?? fallbackArgs.function;
  const fallbackToolName = typeof fallbackToolValue === "string" ? fallbackToolValue.trim() : "";
  if (!BARE_TOOL_NAMES.has(fallbackToolName)) return calls;

  calls.push({ id: nextCallId(), name: fallbackToolName, arguments: stripToolNameRecoveryFields(fallbackArgs) });
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
  const trimmed = value.trim().replace(/,$/, "");
  if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) return Number(trimmed);
  if (/^(?:true|false)$/i.test(trimmed)) return trimmed.toLowerCase() === "true";
  return trimmed;
}

function parseSinglePositionalArg(text: string): unknown | undefined {
  const trimmed = text.trim().replace(/,$/, "");
  if (!trimmed || trimmed.includes(",") || /^[a-z_][a-z0-9_]*\s*=/i.test(trimmed)) return undefined;

  if (
    (trimmed.startsWith("\"") && trimmed.endsWith("\"")) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    const quote = trimmed[0];
    const body = trimmed.slice(1, -1);
    if (quote === "\"") {
      try {
        return JSON.parse(trimmed);
      } catch {
        return body.replace(/\\"/g, "\"").replace(/\\\\/g, "\\");
      }
    }
    return body.replace(/\\'/g, "'").replace(/\\\\/g, "\\");
  }

  return normalizeInlineArgValue(trimmed);
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

function parseLooseParameterLine(line: string): [string, unknown] | null {
  const trimmed = line.trim();
  if (!trimmed) return null;

  const malformedClose = trimmed.match(/^<\/parameter\s*([a-z_][a-z0-9_]*)["']?\s*>\s*([\s\S]*?)\s*$/i);
  if (malformedClose) {
    return [malformedClose[1], normalizeInlineArgValue(malformedClose[2])];
  }

  const malformedOpen = trimmed.match(/^<?parameter\s+name=["']?([a-z_][a-z0-9_]*)["']?\s*>\s*([\s\S]*?)(?:<\/parameter>)?\s*$/i);
  if (malformedOpen) {
    return [malformedOpen[1], normalizeInlineArgValue(malformedOpen[2])];
  }

  const tagLike = trimmed.match(/^<parameter\s+name=["']?([a-z_][a-z0-9_]*)["']?\s*>\s*([\s\S]*?)(?:<\/parameter>)?\s*$/i);
  if (tagLike) {
    return [tagLike[1], normalizeInlineArgValue(tagLike[2])];
  }

  const namedArgs = parseNamedArguments(trimmed);
  const entries = Object.entries(namedArgs);
  if (entries.length === 1 && /^[a-z_][a-z0-9_]*\s*=/i.test(trimmed)) {
    return entries[0];
  }

  return null;
}

function parseMultilineBareToolCall(
  toolName: string,
  lines: string[],
  index: number,
): { call: ParsedToolCall; consumed: number } | null {
  const args: Record<string, unknown> = {};
  let consumed = 1;
  const next = lines[index + 1]?.trim() || "";

  if (next.startsWith("{") && next.endsWith("}")) {
    try {
      const parsed = JSON.parse(next);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return {
          call: {
            id: nextCallId(),
            name: toolName,
            arguments: parsed,
          },
          consumed: 2,
        };
      }
    } catch {
      // Fall through to the loose line parser.
    }
  }

  if (toolName === "get_project_skeleton" && /^\d+$/.test(next)) {
    return {
      call: {
        id: nextCallId(),
        name: toolName,
        arguments: { depth: Number(next) },
      },
      consumed: 2,
    };
  }

  const positionalArgName = TOOL_POSITIONAL_ARG_NAMES[toolName];
  if (positionalArgName && next && !BARE_TOOL_NAMES.has(next) && !parseLooseParameterLine(next)) {
    const positionalArg = parseSinglePositionalArg(next);
    if (positionalArg !== undefined) {
      args[positionalArgName] = positionalArg;
      consumed = 2;
    }
  }

  let cursor = index + consumed;
  while (cursor < lines.length) {
    const parameter = parseLooseParameterLine(lines[cursor]);
    if (!parameter) break;
    args[parameter[0]] = parameter[1];
    cursor += 1;
  }

  return {
    call: {
      id: nextCallId(),
      name: toolName,
      arguments: args,
    },
    consumed: Math.max(consumed, cursor - index),
  };
}

function parseFunctionStyleInvocation(text: string): ParsedToolCall | null {
  const match = text.trim().match(/^([a-z_][a-z0-9_]*)\s*\(([\s\S]*)\)$/i);
  if (!match) return null;

  const toolName = match[1];
  if (!BARE_TOOL_NAMES.has(toolName)) return null;

  const body = match[2].trim();
  if (!body) {
    return {
      id: nextCallId(),
      name: toolName,
      arguments: {},
    };
  }

  if (body.startsWith("{") && body.endsWith("}")) {
    try {
      const parsed = JSON.parse(body);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return {
          id: nextCallId(),
          name: toolName,
          arguments: parsed,
        };
      }
    } catch {
      // Fall through to the named-argument parser.
    }
  }

  const args = parseNamedArguments(body);
  if (Object.keys(args).length > 0) {
    return {
      id: nextCallId(),
      name: toolName,
      arguments: args,
    };
  }

  if (toolName === "get_project_skeleton" && /^\d+$/.test(body)) {
    return {
      id: nextCallId(),
      name: toolName,
      arguments: { depth: Number(body) },
    };
  }

  if (toolName === "execute_command" || toolName === "run_command") {
    return {
      id: nextCallId(),
      name: toolName,
      arguments: { command: body },
    };
  }

  const positionalArgName = TOOL_POSITIONAL_ARG_NAMES[toolName];
  const positionalArg = positionalArgName ? parseSinglePositionalArg(body) : undefined;
  if (positionalArgName && positionalArg !== undefined) {
    return {
      id: nextCallId(),
      name: toolName,
      arguments: { [positionalArgName]: positionalArg },
    };
  }

  return null;
}

function parseToolCodeBlock(inner: string): ParsedToolCall[] {
  const normalized = inner
    .trim()
    .replace(/^```[a-z0-9_-]*\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  const parsed = parseInlineToolInvocation(normalized);
  return parsed ? [parsed] : [];
}

function parseInlineToolInvocation(text: string): ParsedToolCall | null {
  const trimmed = text.trim();
  if (!trimmed) return null;

  const functionStyleCall = parseFunctionStyleInvocation(trimmed);
  if (functionStyleCall) return functionStyleCall;

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

    if (BARE_TOOL_NAMES.has(trimmed)) {
      const multilineCall = parseMultilineBareToolCall(trimmed, lines, i);
      if (multilineCall) {
        toolCalls.push(multilineCall.call);
        i += multilineCall.consumed;
        continue;
      }
    }

    const inlineCall = parseInlineToolInvocation(trimmed);
    if (inlineCall) {
      toolCalls.push(inlineCall);
      i += 1;
      continue;
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

  // Format 4: local-model tool_code wrappers with a single function-style call
  const toolCodeBlocks = extractMatches(text, /<tool_code(?:\s[^>]*)?>([\s\S]*?)<\/tool_code>/);
  for (const block of toolCodeBlocks) {
    toolCalls.push(...parseToolCodeBlock(block));
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
    .replace(/<tool_code(?:\s[^>]*)?>[\s\S]*?<\/tool_code>/g, "")
    .replace(
      /<\/?(?:analysis|thought|thinking|reasoning|tool_use|tool_call|function_call|tool_code|tool|parameter|tool_response)(?:\s[^>]*)?>/g,
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
