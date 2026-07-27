/** A tool call in the assistant message (OpenAI format). */
export interface ToolCallInMessage {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

/** Multimodal content parts (OpenAI-compatible format). */
export interface TextContentPart {
  type: "text";
  text: string;
}

export interface ImageUrlContentPart {
  type: "image_url";
  image_url: { url: string };
}

export type ContentPart = TextContentPart | ImageUrlContentPart;

/** Message format supporting native tool calling and multimodal content. */
export interface AgentMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | ContentPart[];
  /** Runtime-only Turn owner for exact multimodal transport receipts. */
  runtimeTurnId?: string;
  runtimeVisualImageParts?: number;
  runtimeVisualPayloadDigest?: string;
  tool_calls?: ToolCallInMessage[];
  tool_call_id?: string;
  reasoning_content?: string;
  reasoning?: string;
}
