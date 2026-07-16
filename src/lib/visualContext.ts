export type VisualContextDeliveryStatus =
  | "none"
  | "queued"
  | "delivered"
  | "partially_delivered"
  | "provider_unsupported"
  | "not_delivered";

export interface VisualContextDeliveryState {
  status: VisualContextDeliveryStatus;
  expectedImageParts: number;
  deliveredImageParts: number;
  omittedImageParts: number;
  /** Model-side inspection state. Transport alone always leaves this pending. */
  recognition?: "pending" | "observed" | "unverified";
  /** Bounded, model-authored observation accepted through the visual protocol. */
  observationSummary?: string;
  /** Stable identity used to deduplicate repeated protocol markers. */
  observationId?: string;
}

/**
 * Provider-owned receipt for the exact request that produced one model
 * response. Logical messages are not proof of transport: only the final
 * serialized request body and a successfully accepted request may report
 * delivered image parts.
 */
export interface VisualTransportReceipt {
  protocol: string;
  requestAccepted: boolean;
  logicalImageParts: number;
  serializedImageParts: number;
  omittedImageParts: number;
  omissionReason?: string;
}

/**
 * Delivery is monotonic within one run. Later context compaction can remove a
 * large data URL from subsequent requests, but it cannot undo the fact that
 * the model already received it. A first-request provider rejection is still
 * recorded because no delivered state exists yet.
 */
export function resolveMonotonicVisualContextStatus(
  previous: VisualContextDeliveryStatus,
  observed: VisualContextDeliveryStatus,
): VisualContextDeliveryStatus {
  if (previous === "delivered" && observed !== "delivered") return "delivered";
  if (previous === "provider_unsupported") return "provider_unsupported";
  if (
    previous === "partially_delivered" &&
    (observed === "none" || observed === "queued" || observed === "not_delivered")
  ) {
    return "partially_delivered";
  }
  return observed;
}

type VisualMessageLike = {
  role?: string;
  content?: unknown;
};

export const VISUAL_CONTEXT_OMISSION_OPEN = "[visual_context_omission]";
export const VISUAL_CONTEXT_OMISSION_CLOSE = "[/visual_context_omission]";
export const VISUAL_CONTEXT_DELIVERY_OPEN = "[visual_context_delivery]";
export const VISUAL_CONTEXT_DELIVERY_CLOSE = "[/visual_context_delivery]";

const VISUAL_OBSERVATION_COMMENT_RE =
  /<!--\s*MAIN_VISUAL_OBSERVATION\s*([\s\S]*?)-->/gi;
const UNTERMINATED_VISUAL_OBSERVATION_COMMENT_RE =
  /<!--\s*MAIN_VISUAL_OBSERVATION\b[\s\S]*$/gi;
const MAX_VISUAL_OBSERVATION_SUMMARY_CHARS = 360;

export interface VisualContextRecognitionObservation {
  turnId: string;
  imageCount: number;
  summary: string;
  observationId: string;
  recognition: "observed";
  evidenceMeaning: "model_visual_observation";
}

export interface VisualContextRecognitionParseResult {
  cleanedText: string;
  observation: VisualContextRecognitionObservation | null;
}

export interface VisualContextDeliveryObservation extends VisualContextDeliveryState {
  turnId: string;
  evidenceMeaning: "transport_only";
  recognition: "unverified";
}

function normalizeImageCount(value: unknown): number {
  const count = Math.floor(Number(value) || 0);
  return Math.max(0, count);
}

function compactObservationSummary(value: unknown): string {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_VISUAL_OBSERVATION_SUMMARY_CHARS);
}

function visualObservationId(turnId: string, imageCount: number, summary: string): string {
  const source = `${turnId}\u0000${imageCount}\u0000${summary}`;
  let hash = 0x811c9dc5;
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `visual-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

/**
 * Adds a provider-neutral response contract for image-bearing turns. The
 * marker is an HTML comment so it never becomes user-facing assistant prose.
 * MAIN accepts it only after the exact turn's image payload was delivered.
 */
export function appendVisualObservationProtocol(
  systemPrompt: string,
  input: { turnId: string; imageCount: number },
): string {
  const turnId = String(input.turnId || "").trim();
  const imageCount = normalizeImageCount(input.imageCount);
  if (!turnId || imageCount <= 0) return systemPrompt;
  return [
    String(systemPrompt || "").trimEnd(),
    "",
    "[visual_observation_protocol]",
    `This turn contains ${imageCount} image part${imageCount === 1 ? "" : "s"}. Inspect the actual pixels before relying on visual details.`,
    "After inspection, emit exactly one hidden HTML comment named MAIN_VISUAL_OBSERVATION whose body is a JSON object.",
    `The JSON fields are: turnId (exactly ${JSON.stringify(turnId)}), imageCount (exactly ${imageCount}), and summary (one concise statement of directly visible facts).`,
    "Do not emit the comment when the images are unavailable, and do not use intentions, delivery claims, source-code conclusions, or guessed facts as the summary.",
    "[/visual_observation_protocol]",
  ].join("\n");
}

/**
 * Removes every protocol comment from display/history and accepts at most one
 * observation bound to the exact delivered turn. Arbitrary assistant prose,
 * localized keywords, and transport status are deliberately ignored.
 */
export function parseVisualContextRecognition(input: {
  text: string;
  expectedTurnId: string;
  expectedImageParts: number;
  deliveryStatus: VisualContextDeliveryStatus;
}): VisualContextRecognitionParseResult {
  const rawText = String(input.text || "");
  const expectedTurnId = String(input.expectedTurnId || "").trim();
  const expectedImageParts = normalizeImageCount(input.expectedImageParts);
  let observation: VisualContextRecognitionObservation | null = null;
  const cleanedText = rawText.replace(VISUAL_OBSERVATION_COMMENT_RE, (_full, body: string) => {
    if (
      observation ||
      input.deliveryStatus !== "delivered" ||
      !expectedTurnId ||
      expectedImageParts <= 0
    ) {
      return "";
    }
    try {
      const value = JSON.parse(String(body || "").trim()) as Record<string, unknown>;
      const turnId = String(value.turnId || "").trim();
      const imageCount = normalizeImageCount(value.imageCount);
      const summary = compactObservationSummary(value.summary);
      if (
        turnId !== expectedTurnId ||
        imageCount !== expectedImageParts ||
        !summary
      ) {
        return "";
      }
      observation = {
        turnId,
        imageCount,
        summary,
        observationId: visualObservationId(turnId, imageCount, summary),
        recognition: "observed",
        evidenceMeaning: "model_visual_observation",
      };
    } catch {
      // Malformed model metadata is removed from display but is not evidence.
    }
    return "";
  })
    .replace(UNTERMINATED_VISUAL_OBSERVATION_COMMENT_RE, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { cleanedText, observation };
}

function getVisualMessageText(message: VisualMessageLike): string {
  return typeof message?.content === "string"
    ? message.content
    : Array.isArray(message?.content)
    ? message.content
        .filter((part) => !!part && typeof part === "object" && (part as { type?: unknown }).type === "text")
        .map((part) => String((part as { text?: unknown }).text || ""))
        .join("\n")
    : "";
}

export function countVisualContentParts(messages: VisualMessageLike[]): number {
  let count = 0;
  for (const message of messages || []) {
    if (!Array.isArray(message?.content)) continue;
    count += message.content.filter((part) =>
      !!part &&
      typeof part === "object" &&
      ((part as { type?: unknown }).type === "image_url" ||
        (part as { type?: unknown }).type === "input_image")
    ).length;
  }
  return count;
}

export function buildProviderUnsupportedVisualContextNotice(imageCount: number): string {
  const count = normalizeImageCount(imageCount);
  return [
    VISUAL_CONTEXT_OMISSION_OPEN,
    "status: provider_unsupported",
    `imageCount: ${count}`,
    "instruction: The provider did not receive these images. Do not infer or claim visual details from them.",
    VISUAL_CONTEXT_OMISSION_CLOSE,
  ].join("\n");
}

export function countProviderOmittedVisualParts(messages: VisualMessageLike[]): number {
  let count = 0;
  const blockPattern = new RegExp(
    `${VISUAL_CONTEXT_OMISSION_OPEN.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([\\s\\S]*?)${VISUAL_CONTEXT_OMISSION_CLOSE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`,
    "g",
  );
  for (const message of messages || []) {
    const text = getVisualMessageText(message);
    for (const match of text.matchAll(blockPattern)) {
      const imageCount = match[1].match(/^imageCount:\s*(\d+)\s*$/mi);
      count += normalizeImageCount(imageCount?.[1]);
    }
  }
  return count;
}

function parseVisualContextDeliveryObservations(
  messages: VisualMessageLike[],
): VisualContextDeliveryObservation[] {
  const observations: VisualContextDeliveryObservation[] = [];
  const blockPattern = new RegExp(
    `${VISUAL_CONTEXT_DELIVERY_OPEN.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([\\s\\S]*?)${VISUAL_CONTEXT_DELIVERY_CLOSE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`,
    "g",
  );
  for (const message of messages || []) {
    // Delivery markers are protocol-owned state. Never accept the same text
    // from canonical user or assistant content as transport evidence.
    if (message?.role !== "system") continue;
    const text = getVisualMessageText(message);
    for (const match of text.matchAll(blockPattern)) {
      try {
        const value = JSON.parse(String(match[1] || "").trim()) as Partial<VisualContextDeliveryObservation>;
        const status = value.status === "delivered" || value.status === "provider_unsupported"
          ? value.status
          : null;
        const turnId = String(value.turnId || "").trim();
        if (!status || !turnId) continue;
        observations.push({
          turnId,
          status,
          expectedImageParts: normalizeImageCount(value.expectedImageParts),
          deliveredImageParts: normalizeImageCount(value.deliveredImageParts),
          omittedImageParts: normalizeImageCount(value.omittedImageParts),
          evidenceMeaning: "transport_only",
          recognition: "unverified",
        });
      } catch {
        // A malformed internal marker is not evidence.
      }
    }
  }
  return observations;
}

export function getVisualContextDeliveryObservation(
  messages: VisualMessageLike[],
  turnId?: string | null,
): VisualContextDeliveryObservation | null {
  const normalizedTurnId = String(turnId || "").trim();
  const observations = parseVisualContextDeliveryObservations(messages);
  for (let index = observations.length - 1; index >= 0; index -= 1) {
    const observation = observations[index];
    if (!normalizedTurnId || observation.turnId === normalizedTurnId) return observation;
  }
  return null;
}

export function preserveVisualContextDeliveryObservationsInSystemPrompt(
  systemPrompt: string,
  messages: VisualMessageLike[],
): string {
  const latestByTurnId = new Map<string, VisualContextDeliveryObservation>();
  for (const observation of parseVisualContextDeliveryObservations(messages)) {
    latestByTurnId.set(observation.turnId, observation);
  }
  if (latestByTurnId.size === 0) return systemPrompt;
  const markers = [...latestByTurnId.values()].map((observation) =>
    `${VISUAL_CONTEXT_DELIVERY_OPEN}\n${JSON.stringify(observation)}\n${VISUAL_CONTEXT_DELIVERY_CLOSE}`
  );
  return `${String(systemPrompt || "").trimEnd()}\n\n${markers.join("\n\n")}`;
}

/**
 * Pins one terminal transport observation into the first system message. The
 * first system message survives context trimming, unlike the original image
 * payload. This marker is internal state and explicitly leaves recognition
 * unverified; it is never emitted as a canonical user instruction.
 */
export function persistVisualContextDeliveryObservation<T extends VisualMessageLike>(
  messages: T[],
  input: {
    turnId: string;
    state: VisualContextDeliveryState;
  },
): { messages: T[]; changed: boolean } {
  const turnId = String(input.turnId || "").trim();
  if (
    !turnId ||
    (input.state.status !== "delivered" && input.state.status !== "provider_unsupported") ||
    getVisualContextDeliveryObservation(messages, turnId)
  ) {
    return { messages, changed: false };
  }
  const systemIndex = messages.findIndex((message) => message?.role === "system");
  if (systemIndex < 0) return { messages, changed: false };

  const observation: VisualContextDeliveryObservation = {
    turnId,
    status: input.state.status,
    expectedImageParts: normalizeImageCount(input.state.expectedImageParts),
    deliveredImageParts: normalizeImageCount(input.state.deliveredImageParts),
    omittedImageParts: normalizeImageCount(input.state.omittedImageParts),
    evidenceMeaning: "transport_only",
    recognition: "unverified",
  };
  const marker = `${VISUAL_CONTEXT_DELIVERY_OPEN}\n${JSON.stringify(observation)}\n${VISUAL_CONTEXT_DELIVERY_CLOSE}`;
  const systemMessage = messages[systemIndex];
  const content = typeof systemMessage.content === "string"
    ? `${systemMessage.content.trimEnd()}\n\n${marker}`
    : Array.isArray(systemMessage.content)
    ? [...systemMessage.content, { type: "text", text: marker }]
    : marker;
  const nextMessages = [...messages];
  nextMessages[systemIndex] = { ...systemMessage, content } as T;
  return { messages: nextMessages, changed: true };
}

/**
 * Reports only whether the newest concrete visual payload in the model
 * transcript was actually present. Assistant prose is intentionally ignored:
 * saying that an image was inspected is not transport evidence.
 */
export function latestVisualContextIsModelVisible(
  messages: VisualMessageLike[],
  turnId?: string | null,
): boolean {
  const persisted = getVisualContextDeliveryObservation(messages, turnId);
  if (persisted) return persisted.status === "delivered";
  // Runtime callers provide a turn identity. Until a successful request pins
  // a transport observation, an image merely present in the queue is not yet
  // model-visible.
  if (String(turnId || "").trim()) return false;
  for (let index = (messages || []).length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    const delivered = countVisualContentParts([message]);
    const omitted = countProviderOmittedVisualParts([message]);
    if (delivered === 0 && omitted === 0) continue;
    return delivered > 0;
  }
  return false;
}

export function resolveVisualContextDeliveryState(input: {
  expectedImageParts: number;
  messagesSentToModel: VisualMessageLike[];
}): VisualContextDeliveryState {
  const expectedImageParts = normalizeImageCount(input.expectedImageParts);
  if (expectedImageParts === 0) {
    return {
      status: "none",
      expectedImageParts: 0,
      deliveredImageParts: 0,
      omittedImageParts: 0,
    };
  }

  // Resolve the newest visual-bearing message so screenshots from an older
  // conversation turn cannot make an omitted current screenshot look sent.
  let deliveredImageParts = 0;
  let omittedImageParts = 0;
  for (let index = input.messagesSentToModel.length - 1; index >= 0; index -= 1) {
    const message = input.messagesSentToModel[index];
    const delivered = countVisualContentParts([message]);
    const omitted = countProviderOmittedVisualParts([message]);
    if (delivered === 0 && omitted === 0) continue;
    deliveredImageParts = delivered;
    omittedImageParts = omitted;
    break;
  }
  const status: VisualContextDeliveryStatus = deliveredImageParts >= expectedImageParts
    ? "delivered"
    : deliveredImageParts > 0
    ? "partially_delivered"
    : omittedImageParts > 0
    ? "provider_unsupported"
    : "not_delivered";

  return {
    status,
    expectedImageParts,
    deliveredImageParts,
    omittedImageParts,
  };
}

export function resolveVisualContextDeliveryStateFromReceipt(input: {
  expectedImageParts: number;
  receipt?: VisualTransportReceipt | null;
}): VisualContextDeliveryState {
  const expectedImageParts = normalizeImageCount(input.expectedImageParts);
  if (expectedImageParts === 0) {
    return {
      status: "none",
      expectedImageParts: 0,
      deliveredImageParts: 0,
      omittedImageParts: 0,
    };
  }

  const receipt = input.receipt;
  const deliveredImageParts = receipt?.requestAccepted
    ? Math.min(
        expectedImageParts,
        normalizeImageCount(receipt.logicalImageParts),
        normalizeImageCount(receipt.serializedImageParts),
      )
    : 0;
  const omittedImageParts = Math.max(
    normalizeImageCount(receipt?.omittedImageParts),
    expectedImageParts - deliveredImageParts,
  );
  const status: VisualContextDeliveryStatus = deliveredImageParts >= expectedImageParts
    ? "delivered"
    : deliveredImageParts > 0
    ? "partially_delivered"
    : receipt?.omissionReason === "provider_unsupported"
    ? "provider_unsupported"
    : "not_delivered";

  return {
    status,
    expectedImageParts,
    deliveredImageParts,
    omittedImageParts,
  };
}
