import {
  TOOL_FEEDBACK_ENVELOPE_PREFIX,
  parseToolFeedbackEnvelope,
} from "./toolFeedbackEnvelope";
import { buildToolProtocolCard } from "./systemPrompt";
import type { ToolDefinition } from "./toolSchemas";
import { buildProviderUnsupportedVisualContextNotice } from "./visualContext";

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
  runtimeTurnId?: string;
  runtimeVisualImageParts?: number;
  runtimeVisualPayloadDigest?: string;
  tool_calls?: CompatibilityToolCall[];
  tool_call_id?: string;
  reasoning_content?: string;
  reasoning?: string;
}

export const PROVIDER_COMPATIBILITY_TAG = "[PROVIDER_COMPATIBILITY_MODE]";

export interface ProviderCompatibilityModeOptions {
  /**
   * Replacement generated from the same frozen Plan contract for the actual
   * compatibility transport. When present, the stale native-only card is
   * removed atomically instead of leaving contradictory submission rules.
   */
  replacementPlanAuthoringContract?: string;
}

export function isProviderCompatibilityErrorMessage(message: string): boolean {
  const normalized = String(message || "").toLowerCase();
  return (
    normalized.includes("unsupported content type") ||
    normalized.includes("unsupported responses") ||
    normalized.includes("responses api is not supported") ||
    normalized.includes("responses api not supported") ||
    normalized.includes("invalid_request_error") ||
    normalized.includes("invalid type for") ||
    normalized.includes("unsupported parameter") ||
    normalized.includes("unknown parameter") ||
    normalized.includes("unrecognized request argument") ||
    normalized.includes("unrecognized field") ||
    normalized.includes("invalid 'messages'") ||
    normalized.includes('invalid "messages"') ||
    normalized.includes("invalid messages") ||
    normalized.includes("messages[") ||
    normalized.includes("tool_calls") ||
    normalized.includes("\"tools\"") ||
    normalized.includes("'tools'") ||
    normalized.includes(" tools ")
  );
}

export function isNativeToolCompatibilityErrorMessage(message: string): boolean {
  const normalized = String(message || "").toLowerCase();
  if (!isProviderCompatibilityErrorMessage(normalized)) return false;
  return (
    normalized.includes("tool_calls") ||
    normalized.includes("invalid 'messages'") ||
    normalized.includes('invalid "messages"') ||
    normalized.includes("invalid messages") ||
    normalized.includes("\"tools\"") ||
    normalized.includes("'tools'") ||
    normalized.includes(" tools ") ||
    normalized.includes("function_call") ||
    normalized.includes("function tools")
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

function countImageContent(content: CompatibilityMessage["content"]): number {
  return Array.isArray(content)
    ? content.filter((part) => part.type === "image_url").length
    : 0;
}

export type CompatibilityImageHandling = "preserve" | "omit_unsupported";

/**
 * Detect errors that reject multimodal message content itself. Tool-schema
 * fallback and image fallback are separate capabilities: an XML tool lane can
 * still accept OpenAI-compatible image content.
 */
export function isProviderImageContentCompatibilityErrorMessage(message: string): boolean {
  const normalized = String(message || "").toLowerCase();
  if (
    /\b(?:image_url|input_image|image|vision|multimodal)\b/.test(normalized) &&
    /(?:unsupported|not supported|invalid|reject|cannot|can't|does not accept)/.test(normalized)
  ) return true;
  if (!isProviderCompatibilityErrorMessage(normalized)) return false;
  return (
    normalized.includes("unsupported content type") ||
    /invalid type for messages\[\d+\]\.content/.test(normalized) ||
    /messages\[\d+\]\.content.{0,80}(?:string|array|object)/.test(normalized) ||
    /content.{0,50}(?:must be|expected).{0,30}string/.test(normalized)
  );
}

function buildProviderCompatibilityInstructionText(
  workflowMode: "chat" | "edit" | "plan",
  toolDefinitions: ToolDefinition[] = [],
): string {
  const toolNames = toolDefinitions.map((tool) => tool.function.name);
  const protocolCard = buildToolProtocolCard({
    activeProfile: "cloud",
    provider: "compatibility-fallback",
    toolProtocol: "xml",
    nativeToolsEnabled: false,
    availableToolNames: toolNames,
    toolDefinitions,
    descriptionMaxChars: 120,
    language: "en",
  });
  return [
    PROVIDER_COMPATIBILITY_TAG,
    "native_tools_disabled=true",
    protocolCard,
    `workflowMode=${workflowMode}. The catalog above is the complete intent-scoped tool surface for this retry.`,
    "Do not reuse a tool name from earlier history unless it is present in this catalog.",
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
  toolDefinitions: ToolDefinition[] = [],
): CompatibilityMessage {
  return {
    role: "system",
    content: buildProviderCompatibilityInstructionText(workflowMode, toolDefinitions),
  };
}

const TOOL_PROTOCOL_SECTION_PATTERN = /(?:^|\n)\[TOOLS\]\n[\s\S]*?(?=\n\n\[[A-Z0-9 _():/.-]+\]\n|$)/g;
const PLAN_AUTHORING_CONTRACT_SECTION_PATTERN =
  /(?:^|\n)\[PLAN AUTHORING CONTRACT\]\n[\s\S]*?\n\[\/PLAN AUTHORING CONTRACT\](?=\n|$)/g;

function stripToolProtocolSection(content: string): string {
  return content.replace(TOOL_PROTOCOL_SECTION_PATTERN, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

function stripPlanAuthoringContractSection(content: string): string {
  return content
    .replace(PLAN_AUTHORING_CONTRACT_SECTION_PATTERN, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function ensureProviderCompatibilityMode(
  messages: CompatibilityMessage[],
  workflowMode: "chat" | "edit" | "plan",
  toolDefinitions: ToolDefinition[] = [],
  options: ProviderCompatibilityModeOptions = {},
): CompatibilityMessage[] {
  const replacementPlanAuthoringContract = String(
    options.replacementPlanAuthoringContract || "",
  ).trim();
  const sanitized = messages.flatMap((message): CompatibilityMessage[] => {
    if (message.role !== "system" || typeof message.content !== "string") return [message];
    if (
      message.content.includes(PROVIDER_COMPATIBILITY_TAG) &&
      message.content.includes("native_tools_disabled=true")
    ) return [];
    const withoutNativeToolCard = stripToolProtocolSection(message.content);
    const content = replacementPlanAuthoringContract
      ? stripPlanAuthoringContractSection(withoutNativeToolCard)
      : withoutNativeToolCard;
    return content ? [{ ...message, content }] : [];
  });
  return [
    ...sanitized,
    buildProviderCompatibilitySystemMessage(workflowMode, toolDefinitions),
    ...(replacementPlanAuthoringContract
      ? [{ role: "system" as const, content: replacementPlanAuthoringContract }]
      : []),
  ];
}

export function buildCompatibilityRetryMessages(
  messages: CompatibilityMessage[],
  options: { imageHandling?: CompatibilityImageHandling } = {},
): CompatibilityMessage[] {
  const imageHandling = options.imageHandling || "preserve";
  const toolNamesByCallId = new Map<string, string>();
  for (const message of messages) {
    if (message.role !== "assistant" || !Array.isArray(message.tool_calls)) continue;
    for (const toolCall of message.tool_calls) {
      if (toolCall.id && toolCall.function?.name) {
        toolNamesByCallId.set(toolCall.id, toolCall.function.name);
      }
    }
  }

  return messages.map((message) => {
    const textContent = extractCompatibilityTextContent(message.content);
    const imageCount = countImageContent(message.content);
    const compatibilityText = [
      textContent,
      imageCount > 0 && imageHandling === "omit_unsupported"
        ? buildProviderUnsupportedVisualContextNotice(imageCount)
        : "",
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

    // XML/native-tool compatibility changes the tool-call representation, not
    // the user's visual input. Preserve multimodal user content unless the
    // provider explicitly rejected the content shape itself.
    if (message.role === "user" && Array.isArray(message.content) && hasImageContent(message.content) && imageHandling === "preserve") {
      return {
        role: "user",
        content: message.content.map((part) => part.type === "text"
          ? { type: "text" as const, text: part.text }
          : { type: "image_url" as const, image_url: { url: part.image_url.url } }),
        ...(message.runtimeTurnId ? { runtimeTurnId: message.runtimeTurnId } : {}),
        ...(message.runtimeVisualImageParts
          ? { runtimeVisualImageParts: message.runtimeVisualImageParts }
          : {}),
        ...(message.runtimeVisualPayloadDigest
          ? { runtimeVisualPayloadDigest: message.runtimeVisualPayloadDigest }
          : {}),
      };
    }

    if (message.role === "tool") {
      const rawToolContent = typeof message.content === "string"
        ? message.content
        : compatibilityText || String(message.content);
      const parsedEnvelope = parseToolFeedbackEnvelope(rawToolContent);
      const toolName = parsedEnvelope?.envelope.tool || (
        message.tool_call_id ? toolNamesByCallId.get(message.tool_call_id) : ""
      );
      const preserveExactFileRead =
        toolName === "read_file" ||
        /(?:^|\n)(?:READ_FILE_RESULT|CACHED_FILE_REPLAY)\b/.test(rawToolContent);
      if (parsedEnvelope) {
        const envelopeHeader = `${TOOL_FEEDBACK_ENVELOPE_PREFIX}${JSON.stringify(parsedEnvelope.envelope)}`;
        // XML/compat mode changes the role representation, not the file-read
        // observation itself. Context management already owns token budgets;
        // truncating an exact read window here makes the model request the same
        // range while the cache incorrectly believes the full source is active.
        const body = preserveExactFileRead
          ? parsedEnvelope.body
          : parsedEnvelope.body.slice(0, 800);
        return {
          role: "user",
          content: [
            "[Tool result]:",
            envelopeHeader,
            body,
          ].filter(Boolean).join("\n"),
        };
      }
      return {
        role: "user",
        content: `[Tool result]: ${preserveExactFileRead
          ? compatibilityText || String(message.content)
          : (compatibilityText || String(message.content)).slice(0, 800)}`,
      };
    }

    return {
      role: message.role,
      content: compatibilityText,
      ...(message.role === "user" && message.runtimeTurnId
        ? { runtimeTurnId: message.runtimeTurnId }
        : {}),
      ...(message.role === "user" && message.runtimeVisualImageParts
        ? { runtimeVisualImageParts: message.runtimeVisualImageParts }
        : {}),
      ...(message.role === "user" && message.runtimeVisualPayloadDigest
        ? { runtimeVisualPayloadDigest: message.runtimeVisualPayloadDigest }
        : {}),
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
  toolDefinitions: ToolDefinition[] = [],
): CompatibilityMessage[] {
  // A transcript retry is intentionally plain text. Record the visual loss as
  // structured unsupported context so the model cannot pretend it saw images.
  const flattened = buildCompatibilityRetryMessages(messages, {
    imageHandling: "omit_unsupported",
  }).flatMap((message): CompatibilityMessage[] => {
    if (message.role !== "system" || typeof message.content !== "string") return [message];
    if (message.content.includes(PROVIDER_COMPATIBILITY_TAG)) return [];
    const content = stripToolProtocolSection(message.content);
    return content ? [{ ...message, content }] : [];
  });
  const transcript = flattened
    .map((message, index) => {
      const text = extractCompatibilityTextContent(message.content).trim();
      if (!text) return "";
      return `[${labelForRole(message.role)} ${index + 1}]\n${text}`;
    })
    .filter(Boolean)
    .join("\n\n");

  const instructionText = buildProviderCompatibilityInstructionText(workflowMode, toolDefinitions)
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
      toolDefinitions.length > 0
        ? "Reply normally. If tool use is necessary, emit only one XML call from the active catalog."
        : "Reply normally. No tool is available in this transcript fallback.",
    ].join("\n").trim(),
  }];
}
