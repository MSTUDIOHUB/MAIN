import type { AgentMessage } from "../../lib/agentMessages";
import {
  deriveRuntimeV2TerminalAcceptanceFacts,
  renderRuntimeV2AcceptanceSection,
  type TurnAggregateV1,
} from "../../lib/runtime-v2";

const MAX_TOOL_CONTENT_CHARS_IN_CONCLUDE = 600;
const MAX_ASSISTANT_ARGS_CHARS_IN_CONCLUDE = 600;

function compactToolContent(content: string): string {
  const firstLine = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean)
    ?.slice(0, 180) || "";
  return `[Compacted for conclude (${content.length} chars): ${firstLine}]`;
}

function compactAssistantArguments(rawArgs: string): string {
  try {
    const parsed = JSON.parse(rawArgs) as Record<string, unknown> | null;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const target = parsed.path || parsed.file_path || parsed.target || parsed.command || "";
      return JSON.stringify({
        ...(target ? { target } : {}),
        compactedFromChars: rawArgs.length,
      });
    }
  } catch {
    // Fall back to length placeholder when unparseable.
  }
  return JSON.stringify({ compactedFromChars: rawArgs.length });
}

/** Build a compact, non-mutating conversation snapshot for `mode === "conclude"` so
 * large historical file reads and write payloads do not inflate the summary request
 * while keeping user instructions, guidance, and runtime acceptance facts intact. */
export function buildCompactRuntimeV2ConcludeConversation(input: {
  readonly messages: readonly AgentMessage[];
  readonly aggregate: TurnAggregateV1 | null;
  readonly language?: "zh" | "en";
}): AgentMessage[] {
  const compacted = input.messages.map((message): AgentMessage => {
    if (message.role === "system" || message.role === "user") {
      return message;
    }
    if (
      message.role === "tool" &&
      typeof message.content === "string" &&
      message.content.length > MAX_TOOL_CONTENT_CHARS_IN_CONCLUDE
    ) {
      return {
        ...message,
        content: compactToolContent(message.content),
      };
    }
    if (message.role === "assistant" && Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
      let changed = false;
      const toolCalls = message.tool_calls.map((call) => {
        const args = call.function?.arguments;
        if (typeof args === "string" && args.length > MAX_ASSISTANT_ARGS_CHARS_IN_CONCLUDE) {
          changed = true;
          return {
            ...call,
            function: {
              ...call.function,
              arguments: compactAssistantArguments(args),
            },
          };
        }
        return call;
      });
      return changed ? { ...message, tool_calls: toolCalls } : message;
    }
    return message;
  });

  if (!input.aggregate) return compacted;
  const facts = deriveRuntimeV2TerminalAcceptanceFacts(input.aggregate);
  const summarySection = renderRuntimeV2AcceptanceSection(
    facts,
    input.language === "en" ? "en" : "zh",
  );
  if (!summarySection) return compacted;
  return [
    ...compacted,
    {
      role: "system",
      content: [
        "[Runtime v2 terminal acceptance ledger snapshot]",
        summarySection,
      ].join("\n"),
    },
  ];
}
