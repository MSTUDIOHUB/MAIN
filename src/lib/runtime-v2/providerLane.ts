import type {
  RuntimeV2NormalizedProviderResult,
  RuntimeV2NormalizedToolCall,
  RuntimeV2ProviderDiagnostic,
  RuntimeV2TransportVariant,
} from "./contracts";
import {
  parseExplicitCompatibilityTokenToolCalls,
} from "../textToolParser";
import type {
  ToolDefinition,
  ToolParameterSchema,
} from "../toolSchemas";

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

export class RuntimeV2ProviderProtocolError extends Error {
  readonly runtimeV2FailureKind = "provider_protocol";

  constructor(
    readonly code:
      | "native_tools_unsupported"
      | "required_tool_missing"
      | "output_truncated"
      | "tool_surface_rejected"
      | "tool_arguments_rejected"
      | "repeated_action_rejected",
    message: string,
  ) {
    super(message);
    this.name = "RuntimeV2ProviderProtocolError";
  }
}

/**
 * The production provider adapter raises this only when structured capability
 * state proves that it has no compatible request candidate. It is not inferred
 * from a request rejection, protocol drift, or retry count.
 */
export class RuntimeV2ProviderTransportsUnavailableError extends Error {
  readonly runtimeV2FailureKind = "provider_transports_unavailable";

  constructor(message = "RUNTIME_V2_PROVIDER_TRANSPORTS_UNAVAILABLE") {
    super(message);
    this.name = "RuntimeV2ProviderTransportsUnavailableError";
  }
}

export function isRuntimeV2ProviderProtocolError(
  error: unknown,
): error is RuntimeV2ProviderProtocolError {
  return error instanceof RuntimeV2ProviderProtocolError ||
    (
      !!error &&
      typeof error === "object" &&
      (error as { runtimeV2FailureKind?: unknown }).runtimeV2FailureKind ===
        "provider_protocol"
    );
}

export function isRuntimeV2ProviderTransportsUnavailableError(
  error: unknown,
): error is RuntimeV2ProviderTransportsUnavailableError {
  return error instanceof RuntimeV2ProviderTransportsUnavailableError ||
    (
      !!error &&
      typeof error === "object" &&
      (error as { runtimeV2FailureKind?: unknown }).runtimeV2FailureKind ===
        "provider_transports_unavailable"
    );
}

/**
 * Preserve a failure from a transport that was actually attempted. A timeout,
 * reset, HTTP failure, or provider overload is a transient request fact; it
 * does not prove that every compatible wire format is unavailable. Only an
 * adapter with no compatible attempt at all may emit the hard capability
 * boundary.
 */
export function runtimeV2ProviderAttemptFailure(
  error: unknown,
): Error {
  if (error instanceof Error) return error;
  if (error !== null && error !== undefined) {
    return new Error(String(error));
  }
  const unknownFailure = new Error(
    "RUNTIME_V2_PROVIDER_ATTEMPT_FAILED_UNKNOWN",
  );
  unknownFailure.name = "RuntimeV2ProviderAttemptError";
  return unknownFailure;
}

/**
 * A transport fallback is capability negotiation, not semantic recovery.
 * When the provider returned a structured but invalid/rejected action, the
 * active transport has already proved that it can express tool calls. Changing
 * the wire format would only replay the same decision with less context.
 */
export function runtimeV2ProviderProtocolErrorAllowsTransportFallback(
  error: unknown,
  observation: {
    readonly activeTransportProven?: boolean;
  } = {},
): boolean {
  return isRuntimeV2ProviderProtocolError(error) &&
    (
      error.code === "native_tools_unsupported" ||
      error.code === "required_tool_missing"
    ) &&
    observation.activeTransportProven !== true;
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
  /**
   * Optional request fact for a native request that advertised exactly one
   * function and explicitly required that function. A few compatible servers
   * return the authored arguments as exact JSON content while ignoring their
   * own named tool_choice. The adapter may recover only that schema-complete
   * object; ordinary JSON answers never enter this path.
   */
  readonly requiredSingleTool?: ToolDefinition;
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

interface ExplicitTextToolEnvelopeParse {
  readonly calls: RuntimeV2NormalizedToolCall[];
  readonly diagnostic?: RuntimeV2ProviderDiagnostic;
}

function exactValueMatchesToolSchema(
  schema: ToolParameterSchema,
  value: unknown,
): boolean {
  if (
    schema.anyOf?.length &&
    !schema.anyOf.some((candidate) =>
      exactValueMatchesToolSchema(candidate, value)
    )
  ) {
    return false;
  }
  if (
    schema.not &&
    exactValueMatchesToolSchema(schema.not, value)
  ) {
    return false;
  }
  if (
    schema.enum?.length &&
    !(typeof value === "string" && schema.enum.includes(value))
  ) {
    return false;
  }
  if (!schema.type) return true;
  if (schema.type === "null") return value === null;
  if (schema.type === "string") return typeof value === "string";
  if (schema.type === "number") {
    return typeof value === "number" && Number.isFinite(value);
  }
  if (schema.type === "boolean") return typeof value === "boolean";
  if (schema.type === "array") {
    return Array.isArray(value) &&
      value.length >= Math.max(0, Number(schema.minItems) || 0) &&
      (!schema.items || value.every((item) =>
        exactValueMatchesToolSchema(schema.items!, item)
      ));
  }
  if (schema.type !== "object") return false;
  const record = asRecord(value);
  if (!record) return false;
  const properties = schema.properties || {};
  const required = new Set(schema.required || []);
  if ([...required].some((key) =>
    !Object.prototype.hasOwnProperty.call(record, key)
  )) {
    return false;
  }
  return Object.entries(record).every(([key, item]) => {
    const property = properties[key];
    if (property) return exactValueMatchesToolSchema(property, item);
    if (schema.additionalProperties === true) return true;
    if (
      schema.additionalProperties &&
      typeof schema.additionalProperties === "object"
    ) {
      return exactValueMatchesToolSchema(
        schema.additionalProperties,
        item,
      );
    }
    // Exact-JSON recovery is intentionally stricter than JSON Schema's
    // default. Unknown keys prove that this is not an unambiguous rendering
    // of the one advertised function's arguments.
    return false;
  });
}

function inspectRequiredSingleToolJson(
  value: unknown,
  tool: ToolDefinition | undefined,
): ExplicitTextToolEnvelopeParse {
  if (!tool || typeof value !== "string") return { calls: [] };
  const raw = value.trim();
  if (
    !raw ||
    raw.length > 32_000 ||
    raw[0] !== "{" ||
    raw[raw.length - 1] !== "}"
  ) {
    return { calls: [] };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { calls: [] };
  }
  if (
    !exactValueMatchesToolSchema(
      tool.function.parameters,
      parsed,
    )
  ) {
    return { calls: [] };
  }
  return {
    calls: [{
      id: "required-single-tool-json",
      name: tool.function.name,
      arguments: parsed as Record<string, unknown>,
    }],
    diagnostic: {
      code: "required_single_tool_json_normalized",
      message:
        "The provider returned exact schema-complete JSON arguments for the sole named required tool; normalized one structured call.",
      retryable: false,
    },
  };
}

function repairExplicitJsonSyntax(value: string): {
  readonly json: string;
  readonly controlCharacters: number;
  readonly trailingCommas: number;
} {
  let escaped = "";
  let inString = false;
  let afterEscape = false;
  let controlCharacters = 0;
  for (const character of value) {
    if (!inString) {
      escaped += character;
      if (character === "\"") inString = true;
      continue;
    }
    if (afterEscape) {
      escaped += character;
      afterEscape = false;
      continue;
    }
    if (character === "\\") {
      escaped += character;
      afterEscape = true;
      continue;
    }
    if (character === "\"") {
      escaped += character;
      inString = false;
      continue;
    }
    const code = character.charCodeAt(0);
    if (code <= 0x1f) {
      controlCharacters += 1;
      escaped += character === "\n"
        ? "\\n"
        : character === "\r"
          ? "\\r"
          : character === "\t"
            ? "\\t"
            : `\\u${code.toString(16).padStart(4, "0")}`;
      continue;
    }
    escaped += character;
  }

  let json = "";
  inString = false;
  afterEscape = false;
  let trailingCommas = 0;
  for (let index = 0; index < escaped.length; index += 1) {
    const character = escaped[index];
    if (inString) {
      json += character;
      if (afterEscape) afterEscape = false;
      else if (character === "\\") afterEscape = true;
      else if (character === "\"") inString = false;
      continue;
    }
    if (character === "\"") {
      inString = true;
      json += character;
      continue;
    }
    if (character === ",") {
      let cursor = index + 1;
      while (cursor < escaped.length && /\s/.test(escaped[cursor])) cursor += 1;
      if (escaped[cursor] === "}" || escaped[cursor] === "]") {
        trailingCommas += 1;
        continue;
      }
    }
    json += character;
  }
  return { json, controlCharacters, trailingCommas };
}

function explicitJsonFailureMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const location = message.match(/position \d+|line \d+(?: column \d+)?/i)?.[0];
  return location
    ? `Explicit tool-envelope JSON is invalid near ${location}.`
    : "Explicit tool-envelope JSON is invalid.";
}

function inspectExplicitTextToolEnvelope(
  value: unknown,
): ExplicitTextToolEnvelopeParse {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw) return { calls: [] };
  const maxScanChars = 262_144;
  const hasExplicitPrefix =
    /<runtime-v2-tools>/.test(raw) ||
    /<\|tool_call>/i.test(raw) ||
    /^```(?:json)?\s*/i.test(raw) ||
    raw.startsWith("{");
  if (raw.length > maxScanChars) {
    return hasExplicitPrefix ? {
      calls: [],
      diagnostic: {
        code: "explicit_tool_envelope_too_large",
        message: `Explicit tool envelope exceeds ${maxScanChars} characters.`,
        retryable: true,
      },
    } : { calls: [] };
  }
  const compatibilityCalls =
    parseExplicitCompatibilityTokenToolCalls(raw);
  if (compatibilityCalls.length > 0) {
    return {
      calls: compatibilityCalls.map((call) => ({
        id: call.id,
        name: call.name,
        arguments: call.arguments,
      })),
    };
  }
  if (/<\|tool_call>/i.test(raw)) {
    return {
      calls: [],
      diagnostic: {
        code: /<\|\/tool_call>/i.test(raw) || /}\s*$/.test(raw)
          ? "explicit_tool_envelope_invalid_calls"
          : "explicit_tool_envelope_incomplete",
        message:
          "The explicit compatibility tool marker contains no complete valid tool call.",
        retryable: true,
      },
    };
  }
  const matches = Array.from(
    raw.matchAll(
      /<runtime-v2-tools>\s*([\s\S]+?)\s*<\/runtime-v2-tools>/g,
    ),
  );
  if (matches.length > 1) {
    return {
      calls: [],
      diagnostic: {
        code: "explicit_tool_envelope_ambiguous",
        message: "More than one explicit tool envelope was returned.",
        retryable: true,
      },
    };
  }
  const hasMarker = /<\/?runtime-v2-tools>/.test(raw);
  const fenced = raw.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  const exactJson = raw.startsWith("{");
  if (matches.length === 0 && !fenced && !exactJson) return { calls: [] };
  if (hasMarker && matches.length === 0) {
    return {
      calls: [],
      diagnostic: {
        code: "explicit_tool_envelope_incomplete",
        message: "The explicit tool envelope is missing a matching boundary.",
        retryable: true,
      },
    };
  }
  const explicitJson = matches[0]?.[1] ?? fenced?.[1] ?? raw;
  let parsed: unknown;
  let repair: ReturnType<typeof repairExplicitJsonSyntax> | null = null;
  try {
    parsed = JSON.parse(explicitJson);
  } catch (strictError) {
    repair = repairExplicitJsonSyntax(explicitJson);
    if (repair.json === explicitJson) {
      return {
        calls: [],
        diagnostic: {
          code: "explicit_tool_envelope_invalid_json",
          message: explicitJsonFailureMessage(strictError),
          retryable: true,
        },
      };
    }
    try {
      parsed = JSON.parse(repair.json);
    } catch (repairError) {
      return {
        calls: [],
        diagnostic: {
          code: "explicit_tool_envelope_invalid_json",
          message: explicitJsonFailureMessage(repairError),
          retryable: true,
        },
      };
    }
  }
  const record = asRecord(parsed);
  if (!record) {
    return {
      calls: [],
      diagnostic: {
        code: "explicit_tool_envelope_invalid_shape",
        message: "Explicit tool-envelope JSON must be an object.",
        retryable: true,
      },
    };
  }
  const rawCalls = record.toolCalls ?? record.tool_calls;
  const calls = Array.isArray(rawCalls)
    ? normalizeToolCalls(rawCalls)
    : record.name || record.function
      ? normalizeToolCalls([record])
      : [];
  const diagnostic = calls.length === 0
    ? {
        code: "explicit_tool_envelope_invalid_calls",
        message: "Explicit tool envelope contains no valid tool call.",
        retryable: true,
      }
    : repair
      ? {
          code: "explicit_tool_envelope_json_normalized",
          message: `Normalized ${repair.controlCharacters} raw control characters and ${repair.trailingCommas} trailing commas inside an explicit tool envelope.`,
          retryable: false,
        }
      : undefined;
  return { calls, ...(diagnostic ? { diagnostic } : {}) };
}

/**
 * Text-envelope parsing accepts one tagged envelope or a response whose whole
 * body is an explicit JSON call (optionally fenced). Bounded commentary is
 * tolerated only around the tagged form. Ordinary prose such as "let me read"
 * still cannot become a lifecycle transition.
 */
export function parseExplicitTextToolEnvelope(value: unknown): RuntimeV2NormalizedToolCall[] {
  return inspectExplicitTextToolEnvelope(value).calls;
}

export function normalizeProviderResponseV1(input: ProviderWireResponse): RuntimeV2NormalizedProviderResult {
  const presentationText = input.visibleText ?? input.content;
  const visibleText = normalizeString(presentationText, 32_000);
  const nativeToolCalls = normalizeToolCalls(input.toolCalls ?? input.tool_calls);
  const requiredJson = nativeToolCalls.length > 0
    ? { calls: [] }
    : inspectRequiredSingleToolJson(
        presentationText,
        input.requiredSingleTool,
      );
  const visibleEnvelope: ExplicitTextToolEnvelopeParse = nativeToolCalls.length > 0 ||
      requiredJson.calls.length > 0
    ? { calls: [] }
    : inspectExplicitTextToolEnvelope(input.visibleText);
  const contentEnvelope: ExplicitTextToolEnvelopeParse = nativeToolCalls.length > 0 ||
      requiredJson.calls.length > 0 ||
      visibleEnvelope.calls.length > 0
    ? { calls: [] }
    : inspectExplicitTextToolEnvelope(input.content);
  const selectedEnvelope = visibleEnvelope.calls.length > 0
    ? visibleEnvelope
    : contentEnvelope.calls.length > 0 || contentEnvelope.diagnostic
      ? contentEnvelope
      : visibleEnvelope;
  const toolCalls = nativeToolCalls.length > 0
    ? nativeToolCalls
    : requiredJson.calls.length > 0
      ? requiredJson.calls
      : selectedEnvelope.calls;
  const diagnostics = [
    ...normalizeDiagnostics(input.diagnostics),
    ...(requiredJson.diagnostic
      ? [requiredJson.diagnostic]
      : selectedEnvelope.diagnostic
        ? [selectedEnvelope.diagnostic]
        : []),
  ];
  const result: RuntimeV2NormalizedProviderResult = {
    toolCalls,
    diagnostics,
    ...(visibleText && requiredJson.calls.length === 0
      ? { visibleText }
      : {}),
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
  if (profile.nativeTools && profile.requiredToolChoice) {
    variants.push("native_required");
  } else if (profile.nativeTools) {
    variants.push("native_auto");
  }
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
    // OpenAI-compatible APIs define omitted tool_choice as automatic
    // selection. Omitting the optional field is more interoperable than
    // forcing an explicit value on local servers while preserving the same
    // observable agent-loop semantics.
    return { variant: next, toolChoice: null, textEnvelope: false };
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
