import type {
  RuntimeV2NormalizedProviderResult,
  RuntimeV2NormalizedToolCall,
  RuntimeV2ProviderDiagnostic,
  RuntimeV2TransportVariant,
} from "./contracts";

export interface ProviderLaneProfileV1 {
  readonly schemaVersion: "provider-lane.v1";
  readonly nativeTools: boolean;
  readonly requiredToolChoice: boolean;
  readonly streaming: boolean;
  readonly textToolEnvelope: boolean;
  readonly reasoning: boolean;
  readonly imageInput: boolean;
  readonly toolResultRole: "tool" | "assistant" | "user";
}

export interface ProviderActionEpochV1 {
  readonly actionKey: string;
  readonly attempted: readonly RuntimeV2TransportVariant[];
}

export interface ProviderTransportAttempt {
  readonly variant: RuntimeV2TransportVariant;
  readonly toolChoice: "required" | "auto" | null;
  readonly textEnvelope: boolean;
}

export interface ProviderWireToolCall {
  readonly id?: unknown;
  readonly name?: unknown;
  readonly arguments?: unknown;
  readonly function?: {
    readonly name?: unknown;
    readonly arguments?: unknown;
  };
}

export interface ProviderWireResponse {
  readonly visibleText?: unknown;
  readonly commentary?: unknown;
  readonly content?: unknown;
  readonly toolCalls?: unknown;
  readonly tool_calls?: unknown;
  readonly usage?: unknown;
  readonly diagnostics?: unknown;
}

export const DEFAULT_PROVIDER_LANE_PROFILE_V1: ProviderLaneProfileV1 = Object.freeze({
  schemaVersion: "provider-lane.v1",
  nativeTools: false,
  requiredToolChoice: false,
  streaming: true,
  textToolEnvelope: true,
  reasoning: false,
  imageInput: false,
  toolResultRole: "tool",
});

function normalizeString(value: unknown, max = 8_192): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function asObjectArguments(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value !== "string") return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function normalizeToolCalls(value: unknown): RuntimeV2NormalizedToolCall[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const calls: RuntimeV2NormalizedToolCall[] = [];
  for (const [index, raw] of value.entries()) {
    const call = asRecord(raw) as ProviderWireToolCall | null;
    if (!call) continue;
    const functionRecord = asRecord(call.function);
    const name = normalizeString(call.name ?? functionRecord?.name, 256);
    const argumentsValue = asObjectArguments(call.arguments ?? functionRecord?.arguments);
    if (!name || !argumentsValue) continue;
    const id = normalizeString(call.id, 256) || `tool-${index + 1}`;
    const key = `${id}\u0000${name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    calls.push({ id, name, arguments: argumentsValue });
  }
  return calls;
}

function normalizeDiagnostics(value: unknown): RuntimeV2ProviderDiagnostic[] {
  if (!Array.isArray(value)) return [];
  const result: RuntimeV2ProviderDiagnostic[] = [];
  for (const raw of value) {
    const item = asRecord(raw);
    if (!item) continue;
    const code = normalizeString(item.code, 128);
    const message = normalizeString(item.message, 2_000);
    if (!code || !message) continue;
    result.push({ code, message, retryable: item.retryable === true });
    if (result.length >= 12) break;
  }
  return result;
}

function normalizeUsage(value: unknown): Record<string, number> | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const normalized = Object.fromEntries(
    Object.entries(record)
      .filter(([, amount]) => typeof amount === "number" && Number.isFinite(amount) && amount >= 0)
      .map(([key, amount]) => [key, amount as number]),
  );
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

/**
 * Text-envelope parsing deliberately accepts only an explicit JSON envelope.
 * It never searches prose for requests such as "let me read" and therefore
 * cannot turn a model's commentary into a lifecycle transition.
 */
export function parseExplicitTextToolEnvelope(value: unknown): RuntimeV2NormalizedToolCall[] {
  const text = normalizeString(value, 32_000);
  if (!text) return [];
  const match = text.match(/^\s*<runtime-v2-tools>\s*([\s\S]+?)\s*<\/runtime-v2-tools>\s*$/);
  if (!match) return [];
  try {
    const parsed = JSON.parse(match[1]);
    const record = asRecord(parsed);
    return normalizeToolCalls(record?.toolCalls);
  } catch {
    return [];
  }
}

export function normalizeProviderResponseV1(input: ProviderWireResponse): RuntimeV2NormalizedProviderResult {
  const visibleText = normalizeString(input.visibleText ?? input.content, 32_000);
  const explicitTextCalls = parseExplicitTextToolEnvelope(visibleText);
  const nativeToolCalls = normalizeToolCalls(input.toolCalls ?? input.tool_calls);
  const toolCalls = nativeToolCalls.length > 0 ? nativeToolCalls : explicitTextCalls;
  const diagnostics = normalizeDiagnostics(input.diagnostics);
  const result: RuntimeV2NormalizedProviderResult = {
    toolCalls,
    diagnostics,
    ...(visibleText ? { visibleText } : {}),
    ...(normalizeString(input.commentary, 8_000) ? { commentary: normalizeString(input.commentary, 8_000) } : {}),
    ...(normalizeUsage(input.usage) ? { usage: normalizeUsage(input.usage) } : {}),
  };
  return result;
}

export function createProviderActionEpoch(actionKey: string): ProviderActionEpochV1 {
  const normalized = normalizeString(actionKey, 512);
  if (!normalized) throw new Error("Provider action key is required.");
  return { actionKey: normalized, attempted: [] };
}

function supportedVariants(profile: ProviderLaneProfileV1): RuntimeV2TransportVariant[] {
  const variants: RuntimeV2TransportVariant[] = [];
  if (profile.nativeTools && profile.requiredToolChoice) variants.push("native_required");
  if (profile.nativeTools) variants.push("native_auto");
  if (profile.textToolEnvelope) variants.push("text_envelope");
  return variants;
}

/**
 * Bounded transport negotiation. The profile is supplied by structured HTTP
 * observations; the function has no provider-name or model-text branches.
 */
export function selectNextProviderTransportAttempt(
  profile: ProviderLaneProfileV1,
  epoch: ProviderActionEpochV1,
): ProviderTransportAttempt | null {
  const attempted = new Set(epoch.attempted);
  const next = supportedVariants(profile).find((variant) => !attempted.has(variant));
  if (!next) return null;
  if (next === "native_required") {
    return { variant: next, toolChoice: "required", textEnvelope: false };
  }
  if (next === "native_auto") {
    return { variant: next, toolChoice: "auto", textEnvelope: false };
  }
  return { variant: next, toolChoice: null, textEnvelope: true };
}

export function recordProviderTransportAttempt(
  epoch: ProviderActionEpochV1,
  attempt: ProviderTransportAttempt,
): ProviderActionEpochV1 {
  if (epoch.attempted.includes(attempt.variant)) return epoch;
  return { ...epoch, attempted: [...epoch.attempted, attempt.variant] };
}

export function providerActionEpochExhausted(
  profile: ProviderLaneProfileV1,
  epoch: ProviderActionEpochV1,
): boolean {
  return selectNextProviderTransportAttempt(profile, epoch) === null;
}
