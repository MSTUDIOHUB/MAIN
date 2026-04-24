export interface CompatibilityToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

export interface CompatibilityTextContentPart {
  type: "text";
  text: string;
}

export interface CompatibilityImageUrlContentPart {
  type: "image_url";
  image_url: { url: string };
}

export type CompatibilityContentPart =
  | CompatibilityTextContentPart
  | CompatibilityImageUrlContentPart;

export interface CompatibilityMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | CompatibilityContentPart[];
  tool_calls?: CompatibilityToolCall[];
  tool_call_id?: string;
}

export const PROVIDER_COMPATIBILITY_TAG = "[PROVIDER_COMPATIBILITY_MODE]";

export function isProviderCompatibilityErrorMessage(message: string): boolean {
  const normalized = String(message || "").toLowerCase();
  return (
    normalized.includes("unsupported content type") ||
    normalized.includes("invalid_request_error") ||
    normalized.includes("invalid type for") ||
    normalized.includes("messages[") ||
    normalized.includes("tool_calls")
  );
}

export function extractCompatibilityTextContent(content: CompatibilityMessage["content"]): string {
  if (typeof content === "string") return content;
  return content
    .filter((part): part is CompatibilityTextContentPart => part.type === "text")
    .map((part) => part.text)
    .join("\n")
    .trim();
}

function hasImageContent(content: CompatibilityMessage["content"]): boolean {
  return Array.isArray(content) && content.some((part) => part.type === "image_url");
}

function buildProviderCompatibilityInstructionText(
  workflowMode: "chat" | "edit" | "plan",
): string {
  if (workflowMode === "chat") {
    return [
      PROVIDER_COMPATIBILITY_TAG,
      "native_tools_disabled=true",
      "The current cloud provider rejects native tools / tool_calls payloads.",
      "Do not rely on the request `tools` parameter or native JSON tool calls.",
      "When tool use is necessary, you MUST emit XML tool calls in this exact format:",
      "<tool_use>",
      "<tool>read_file</tool>",
      "<parameter name=\"path\">src/foo.ts</parameter>",
      "</tool_use>",
      "Because this is chat mode, only use read-only tools unless the user explicitly switches to implementation/planning mode.",
    ].join("\n");
  }

  return [
    PROVIDER_COMPATIBILITY_TAG,
    "native_tools_disabled=true",
    "The current cloud provider rejects native tools / tool_calls payloads.",
    "Do not rely on the request `tools` parameter or native JSON tool calls.",
    "When tool use is necessary, you MUST emit XML tool calls in this exact format:",
    "<tool_use>",
    "<tool>工具名称</tool>",
    "<parameter name=\"参数名\">参数值</parameter>",
    "</tool_use>",
  ].join("\n");
}

export function hasProviderNativeToolsDisabled(messages: CompatibilityMessage[]): boolean {
  return messages.some((message) =>
    message.role === "system"
    && typeof message.content === "string"
    && message.content.includes(PROVIDER_COMPATIBILITY_TAG)
    && message.content.includes("native_tools_disabled=true"),
  );
}

export function buildProviderCompatibilitySystemMessage(
  workflowMode: "chat" | "edit" | "plan",
): CompatibilityMessage {
  return {
    role: "system",
    content: buildProviderCompatibilityInstructionText(workflowMode),
  };
}

export function ensureProviderCompatibilityMode(
  messages: CompatibilityMessage[],
  workflowMode: "chat" | "edit" | "plan",
): CompatibilityMessage[] {
  if (hasProviderNativeToolsDisabled(messages)) return messages;
  return [...messages, buildProviderCompatibilitySystemMessage(workflowMode)];
}

export function buildCompatibilityRetryMessages(messages: CompatibilityMessage[]): CompatibilityMessage[] {
  return messages.map((message) => {
    const textContent = extractCompatibilityTextContent(message.content);
    const compatibilityText = [
      textContent,
      hasImageContent(message.content) ? "[Image omitted for provider compatibility retry]" : "",
    ]
      .filter(Boolean)
      .join("\n\n")
      .trim();

    if (message.role === "assistant" && message.tool_calls) {
      return {
        role: "assistant",
        content: compatibilityText || `[Tool call: ${message.tool_calls.map((tc) => tc.function.name).join(", ")}]`,
      };
    }

    if (message.role === "tool") {
      return {
        role: "user",
        content: `[Tool result]: ${(compatibilityText || String(message.content)).slice(0, 800)}`,
      };
    }

    return {
      role: message.role,
      content: compatibilityText,
    };
  });
}

function stripCompatibilityMeta(line: string): boolean {
  return line !== PROVIDER_COMPATIBILITY_TAG && line !== "native_tools_disabled=true";
}

function labelForRole(role: CompatibilityMessage["role"]): string {
  switch (role) {
    case "system":
      return "System";
    case "assistant":
      return "Assistant";
    case "tool":
      return "Tool";
    default:
      return "User";
  }
}

export function buildTranscriptCompatibilityRetryMessages(
  messages: CompatibilityMessage[],
  workflowMode: "chat" | "edit" | "plan",
): CompatibilityMessage[] {
  const flattened = buildCompatibilityRetryMessages(messages);
  const transcript = flattened
    .map((message, index) => {
      const text = extractCompatibilityTextContent(message.content).trim();
      if (!text) return "";
      return `[${labelForRole(message.role)} ${index + 1}]\n${text}`;
    })
    .filter(Boolean)
    .join("\n\n");

  const instructionText = buildProviderCompatibilityInstructionText(workflowMode)
    .split("\n")
    .filter(stripCompatibilityMeta)
    .join("\n")
    .trim();

  return [{
    role: "user",
    content: [
      PROVIDER_COMPATIBILITY_TAG,
      "transcript_mode=true",
      "The upstream cloud gateway only accepts basic plain-text messages.",
      "Continue from the transcript below and respond to the latest user intent.",
      "",
      "[Compatibility Instructions]",
      instructionText,
      "",
      "[Conversation Transcript]",
      transcript || "[No prior transcript available.]",
      "",
      "[Reply Rule]",
      "Reply normally. If tool use is necessary, emit XML <tool_use> blocks only.",
    ].join("\n").trim(),
  }];
}
