import { invoke } from "@tauri-apps/api/core";
import type { AgentMessage } from "./agentMessages";
import {
  compactContextForExecuteRecovery,
  computeContextBudgets,
  estimateMessagesTokens,
  type TrimMessage,
} from "./contextTrim";
import {
  getSystemMemory,
  type SystemMemoryInfo,
} from "./ipc";

const GIB = 1024 ** 3;
const MIB = 1024 ** 2;
const MIN_CONTEXT_TOKENS = 4_096;
const MAX_DISCOVERED_CONTEXT_TOKENS = 1_048_576;
const CONTEXT_TOKEN_QUANTUM = 4_096;

/**
 * Shared local KV estimate already used by MAIN's Context settings. It is a
 * capacity estimate, never model capability: provider metadata remains the
 * hard upper bound.
 */
const ESTIMATED_KV_MIB_PER_1K_TOKENS = 130;
const MIN_MEMORY_RESERVE_BYTES = GIB;
const MEMORY_RESERVE_RATIO = 0.1;

export interface RuntimeContextBudget {
  readonly contextLimit: number;
  readonly outputBudget: number;
  readonly inputBudget: number;
  readonly readWindowChars: number;
  readonly source:
    | "configured"
    | "memory"
    | "provider_and_memory";
  readonly providerContextLimit: number | null;
  readonly providerOutputLimit: number | null;
  readonly preserveAssistantReasoning: boolean | null;
  readonly availableMemoryBytes: number | null;
}

export interface OpenAiLocalModelCapability {
  readonly providerContextLimit: number | null;
  readonly providerOutputLimit: number | null;
  readonly loaded: boolean | null;
  readonly preserveAssistantReasoning: boolean | null;
}

interface RuntimeContextConfigLike {
  readonly activeProfile?: string;
  readonly local?: {
    readonly provider?: string;
    readonly endpoint?: string;
    readonly model?: string;
    readonly apiKey?: string;
    readonly contextLimit?: number;
  };
}

interface RuntimeContextBudgetDependencies {
  readonly getSystemMemory?: () => Promise<SystemMemoryInfo>;
  readonly requestJson?: (
    url: string,
    headers: Record<string, string>,
  ) => Promise<unknown>;
}

function finitePositiveInteger(value: unknown): number | null {
  const number = Number(value);
  if (!Number.isFinite(number) || number < MIN_CONTEXT_TOKENS) return null;
  return Math.min(
    MAX_DISCOVERED_CONTEXT_TOKENS,
    Math.floor(number),
  );
}

function modelId(value: unknown): string {
  return String(value || "").trim();
}

function contextLimitFromModelRecord(
  value: unknown,
): number | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  for (const field of [
    "max_model_len",
    "max_context_length",
    "context_length",
    "context_window",
    "contextLength",
  ]) {
    const limit = finitePositiveInteger(record[field]);
    if (limit !== null) return limit;
  }
  return null;
}

function outputLimitFromModelRecord(
  value: unknown,
): number | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  for (const field of [
    "max_output_tokens",
    "max_completion_tokens",
    "maxOutputTokens",
  ]) {
    const number = Number(record[field]);
    if (Number.isFinite(number) && number > 0) {
      return Math.min(
        MAX_DISCOVERED_CONTEXT_TOKENS,
        Math.floor(number),
      );
    }
  }
  return null;
}

export function parseOpenAiLocalModelCapability(input: {
  readonly model: string;
  readonly modelsPayload: unknown;
  readonly statusPayload?: unknown;
}): OpenAiLocalModelCapability {
  const expectedModel = modelId(input.model);
  const modelRecords =
    input.modelsPayload &&
      typeof input.modelsPayload === "object" &&
      Array.isArray((input.modelsPayload as { data?: unknown }).data)
      ? (input.modelsPayload as { data: unknown[] }).data
      : [];
  const modelRecord = modelRecords.find((candidate) =>
    candidate &&
    typeof candidate === "object" &&
    modelId((candidate as Record<string, unknown>).id) === expectedModel
  );

  const statusRecords =
    input.statusPayload &&
      typeof input.statusPayload === "object" &&
      Array.isArray((input.statusPayload as { models?: unknown }).models)
      ? (input.statusPayload as { models: unknown[] }).models
      : [];
  const statusRecord = statusRecords.find((candidate) =>
    candidate &&
    typeof candidate === "object" &&
    modelId((candidate as Record<string, unknown>).id) === expectedModel
  ) as Record<string, unknown> | undefined;
  const loaded = statusRecord
    ? statusRecord.loaded === true && statusRecord.is_loading !== true
    : null;
  const preserveAssistantReasoning =
    typeof statusRecord?.preserve_thinking_default === "boolean"
      ? statusRecord.preserve_thinking_default
      : typeof statusRecord?.preserve_reasoning === "boolean"
        ? statusRecord.preserve_reasoning
        : null;

  return {
    providerContextLimit: contextLimitFromModelRecord(modelRecord),
    providerOutputLimit:
      outputLimitFromModelRecord(statusRecord) ||
      outputLimitFromModelRecord(modelRecord),
    loaded,
    preserveAssistantReasoning,
  };
}

function normalizeConfiguredContextLimit(value: unknown): number {
  return Math.max(
    MIN_CONTEXT_TOKENS,
    Math.min(
      MAX_DISCOVERED_CONTEXT_TOKENS,
      Math.floor(Number(value) || 16_384),
    ),
  );
}

function memoryContextCapacity(availableMemoryBytes: number): number {
  if (
    !Number.isFinite(availableMemoryBytes) ||
    availableMemoryBytes <= 0
  ) {
    return MIN_CONTEXT_TOKENS;
  }
  const reserve = Math.max(
    MIN_MEMORY_RESERVE_BYTES,
    availableMemoryBytes * MEMORY_RESERVE_RATIO,
  );
  const usableBytes = Math.max(0, availableMemoryBytes - reserve);
  const estimatedTokens =
    (usableBytes / (ESTIMATED_KV_MIB_PER_1K_TOKENS * MIB)) * 1_000;
  const quantized = Math.floor(
    estimatedTokens / CONTEXT_TOKEN_QUANTUM,
  ) * CONTEXT_TOKEN_QUANTUM;
  return Math.max(
    MIN_CONTEXT_TOKENS,
    Math.min(MAX_DISCOVERED_CONTEXT_TOKENS, quantized),
  );
}

function readWindowCharsForInputBudget(inputBudget: number): number {
  if (inputBudget <= 0) return 4_000;
  const chars = Math.floor(inputBudget * 0.45 * 2.5);
  return Math.max(4_000, Math.min(64_000, chars));
}

export function computeRuntimeContextBudget(input: {
  readonly configuredContextLimit: number;
  readonly providerContextLimit: number | null;
  readonly providerOutputLimit?: number | null;
  readonly modelLoaded: boolean | null;
  readonly preserveAssistantReasoning?: boolean | null;
  readonly availableMemoryBytes: number | null;
  readonly reservedOutputTokens?: number;
}): RuntimeContextBudget {
  const configured = normalizeConfiguredContextLimit(
    input.configuredContextLimit,
  );
  const providerContextLimit = finitePositiveInteger(
    input.providerContextLimit,
  );
  const canUseProviderCapacity =
    providerContextLimit !== null && input.modelLoaded === true;
  const capabilityLimit = canUseProviderCapacity
    ? providerContextLimit
    : configured;
  const availableMemoryBytes =
    typeof input.availableMemoryBytes === "number" &&
      Number.isFinite(input.availableMemoryBytes)
      ? Math.max(0, input.availableMemoryBytes)
      : null;
  const contextLimit = availableMemoryBytes === null
    ? capabilityLimit
    : Math.min(
        capabilityLimit,
        memoryContextCapacity(availableMemoryBytes),
      );
  const providerOutputLimit = outputLimitFromModelRecord({
    max_output_tokens: input.providerOutputLimit,
  });
  const requestedOutputBudget =
    input.reservedOutputTokens === undefined
      ? providerOutputLimit ?? undefined
      : providerOutputLimit === null
        ? input.reservedOutputTokens
        : Math.min(input.reservedOutputTokens, providerOutputLimit);
  const budgets = computeContextBudgets(contextLimit, requestedOutputBudget);
  const source = canUseProviderCapacity
    ? "provider_and_memory"
    : contextLimit < configured
      ? "memory"
      : "configured";

  return {
    contextLimit,
    outputBudget: budgets.outputBudget,
    inputBudget: budgets.inputBudget,
    readWindowChars: readWindowCharsForInputBudget(budgets.inputBudget),
    source,
    providerContextLimit,
    providerOutputLimit,
    preserveAssistantReasoning:
      typeof input.preserveAssistantReasoning === "boolean"
        ? input.preserveAssistantReasoning
        : null,
    availableMemoryBytes,
  };
}

/**
 * Retain standard assistant/tool pairs according to the Run's real input
 * budget. Counts scale with the transcript; the token-derived tool-content
 * allowance is the pressure boundary.
 */
export function boundRuntimeMessagesToContext(
  messages: readonly AgentMessage[],
  input: {
    readonly contextLimit: number;
    readonly reservedOutputTokens: number;
  },
): AgentMessage[] {
  const contextLimit = Math.max(
    MIN_CONTEXT_TOKENS,
    Math.floor(input.contextLimit),
  );
  const reservedOutputTokens = Math.max(
    1_024,
    Math.min(Math.floor(input.reservedOutputTokens), contextLimit),
  );
  const inputBudget = computeContextBudgets(
    contextLimit,
    reservedOutputTokens,
  ).inputBudget;
  if (
    estimateMessagesTokens(messages as TrimMessage[]) <= inputBudget
  ) {
    return [...messages];
  }
  let trailingInstructionStart = messages.length;
  while (
    trailingInstructionStart > 1 &&
    messages[trailingInstructionStart - 1]?.role === "system"
  ) {
    trailingInstructionStart -= 1;
  }
  const trailingInstructions = messages.slice(
    trailingInstructionStart,
  );
  const compactableMessages = messages.slice(
    0,
    trailingInstructionStart,
  );
  const instructionTokens = estimateMessagesTokens(
    trailingInstructions as TrimMessage[],
  );
  const compactableInputBudget = Math.max(
    1_000,
    inputBudget - instructionTokens,
  );
  const compacted = compactContextForExecuteRecovery(
    compactableMessages as TrimMessage[],
    {
      maxMessages: compactableMessages.length + 1,
      maxToolResultMessages: Math.max(
        1,
        compactableMessages.length,
      ),
      maxToolChars: Math.max(
        1_000,
        Math.floor(compactableInputBudget * 2.5 * 0.65),
      ),
      maxToolCallGroups: Math.max(
        1,
        compactableMessages.length,
      ),
      maxToolResultTokens: Math.max(
        360,
        Math.min(
          4_000,
          Math.floor(compactableInputBudget * 0.25),
        ),
      ),
      // Keep both the current objective and the latest runtime evidence
      // packet. This is a semantic anchor count, not a history/round limit.
      latestUserMessages: 2,
    },
  );
  return [
    ...(compacted.messages as AgentMessage[]),
    ...trailingInstructions,
  ];
}

function normalizedOpenAiBase(endpoint: string): string {
  const trimmed = endpoint.trim().replace(/\/+$/, "");
  if (!trimmed) return "";
  return /\/v1$/i.test(trimmed) ? trimmed : `${trimmed}/v1`;
}

function normalizedNativeProviderBase(endpoint: string): string {
  return endpoint.trim()
    .replace(/\/+$/, "")
    .replace(/\/(?:api\/chat|api\/v1|v1)$/i, "");
}

function emptyLocalModelCapability(
  loaded: boolean | null = null,
): OpenAiLocalModelCapability {
  return {
    providerContextLimit: null,
    providerOutputLimit: null,
    loaded,
    preserveAssistantReasoning: null,
  };
}

function authorizationHeaders(
  apiKey: string,
): Record<string, string> {
  return apiKey
    ? { authorization: `Bearer ${apiKey}` }
    : {};
}

async function defaultRequestJson(
  url: string,
  headers: Record<string, string>,
): Promise<unknown> {
  const body = await invoke<string>("proxy_request", {
    url,
    method: "GET",
    headers: Object.keys(headers).length > 0 ? headers : null,
    body: null,
  });
  return JSON.parse(body);
}

async function readOpenAiLocalCapability(input: {
  readonly endpoint: string;
  readonly model: string;
  readonly apiKey: string;
  readonly requestJson: NonNullable<
    RuntimeContextBudgetDependencies["requestJson"]
  >;
}): Promise<OpenAiLocalModelCapability> {
  const base = normalizedOpenAiBase(input.endpoint);
  if (!base || !input.model) {
    return emptyLocalModelCapability();
  }
  const headers = authorizationHeaders(input.apiKey);
  const [models, status] = await Promise.allSettled([
    input.requestJson(`${base}/models`, headers),
    input.requestJson(`${base}/models/status`, headers),
  ]);
  if (models.status !== "fulfilled") {
    return emptyLocalModelCapability();
  }
  return parseOpenAiLocalModelCapability({
    model: input.model,
    modelsPayload: models.value,
    ...(status.status === "fulfilled"
      ? { statusPayload: status.value }
      : {}),
  });
}

async function readOllamaLocalCapability(input: {
  readonly endpoint: string;
  readonly model: string;
  readonly apiKey: string;
  readonly requestJson: NonNullable<
    RuntimeContextBudgetDependencies["requestJson"]
  >;
}): Promise<OpenAiLocalModelCapability> {
  const base = normalizedNativeProviderBase(input.endpoint);
  if (!base || !input.model) return emptyLocalModelCapability();
  try {
    const payload = await input.requestJson(
      `${base}/api/ps`,
      authorizationHeaders(input.apiKey),
    );
    const records =
      payload &&
        typeof payload === "object" &&
        Array.isArray((payload as { models?: unknown }).models)
        ? (payload as { models: unknown[] }).models
        : [];
    const expectedModel = modelId(input.model);
    const loadedRecord = records.find((candidate) => {
      if (
        !candidate ||
        typeof candidate !== "object" ||
        Array.isArray(candidate)
      ) return false;
      const record = candidate as Record<string, unknown>;
      return modelId(record.model) === expectedModel ||
        modelId(record.name) === expectedModel;
    });
    if (!loadedRecord) return emptyLocalModelCapability(false);
    return {
      providerContextLimit:
        contextLimitFromModelRecord(loadedRecord),
      providerOutputLimit: null,
      loaded: true,
      preserveAssistantReasoning: null,
    };
  } catch {
    return emptyLocalModelCapability();
  }
}

async function readLmStudioLocalCapability(input: {
  readonly endpoint: string;
  readonly model: string;
  readonly apiKey: string;
  readonly requestJson: NonNullable<
    RuntimeContextBudgetDependencies["requestJson"]
  >;
}): Promise<OpenAiLocalModelCapability> {
  const base = normalizedNativeProviderBase(input.endpoint);
  if (!base || !input.model) return emptyLocalModelCapability();
  try {
    const payload = await input.requestJson(
      `${base}/api/v1/models`,
      authorizationHeaders(input.apiKey),
    );
    const records =
      payload &&
        typeof payload === "object" &&
        Array.isArray((payload as { models?: unknown }).models)
        ? (payload as { models: unknown[] }).models
        : [];
    const expectedModel = modelId(input.model);
    let selectedRecord: Record<string, unknown> | null = null;
    let selectedInstance: Record<string, unknown> | null = null;
    for (const candidate of records) {
      if (
        !candidate ||
        typeof candidate !== "object" ||
        Array.isArray(candidate)
      ) continue;
      const record = candidate as Record<string, unknown>;
      const instances = Array.isArray(record.loaded_instances)
        ? record.loaded_instances.filter(
            (instance): instance is Record<string, unknown> =>
              !!instance &&
              typeof instance === "object" &&
              !Array.isArray(instance),
          )
        : [];
      const exactInstance = instances.find((instance) =>
        modelId(instance.id) === expectedModel
      ) || null;
      if (
        modelId(record.key) !== expectedModel &&
        !exactInstance
      ) continue;
      selectedRecord = record;
      selectedInstance = exactInstance || instances[0] || null;
      break;
    }
    if (!selectedRecord) return emptyLocalModelCapability(false);
    const instanceConfig =
      selectedInstance?.config &&
        typeof selectedInstance.config === "object" &&
        !Array.isArray(selectedInstance.config)
        ? selectedInstance.config
        : null;
    return {
      providerContextLimit:
        contextLimitFromModelRecord(instanceConfig),
      providerOutputLimit: null,
      loaded: selectedInstance !== null,
      preserveAssistantReasoning: null,
    };
  } catch {
    return emptyLocalModelCapability();
  }
}

function localProviderCapabilityReader(
  provider: unknown,
): typeof readOpenAiLocalCapability {
  const normalized = String(provider || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
  if (normalized === "ollama") return readOllamaLocalCapability;
  if (normalized === "lmstudio") return readLmStudioLocalCapability;
  return readOpenAiLocalCapability;
}

/**
 * Resolve one Run-level budget. Failure to inspect optional provider or
 * memory metadata falls back to the configured limit; it never blocks a Turn.
 */
export async function resolveRuntimeContextBudget(
  config: RuntimeContextConfigLike,
  dependencies: RuntimeContextBudgetDependencies = {},
): Promise<RuntimeContextBudget | null> {
  const local = config.local || {};
  const configuredContextLimit = normalizeConfiguredContextLimit(
    local.contextLimit,
  );
  if (config.activeProfile === "cloud") {
    return null;
  }
  const endpoint = String(local.endpoint || "").trim();
  const model = String(local.model || "").trim();
  if (!endpoint || !model) {
    return computeRuntimeContextBudget({
      configuredContextLimit,
      providerContextLimit: null,
      modelLoaded: null,
      availableMemoryBytes: null,
    });
  }
  const getMemory = dependencies.getSystemMemory || getSystemMemory;
  const requestJson = dependencies.requestJson || defaultRequestJson;
  const readCapability = localProviderCapabilityReader(local.provider);
  const [memory, capability] = await Promise.allSettled([
    getMemory(),
    readCapability({
      endpoint,
      model,
      apiKey: String(local.apiKey || ""),
      requestJson,
    }),
  ]);
  const availableMemoryBytes = memory.status === "fulfilled"
    ? Number(memory.value.available_bytes) ||
      Number(memory.value.available_gb) * GIB ||
      null
    : null;
  const modelCapability = capability.status === "fulfilled"
    ? capability.value
    : {
        providerContextLimit: null,
        providerOutputLimit: null,
        loaded: null,
        preserveAssistantReasoning: null,
      };

  return computeRuntimeContextBudget({
    configuredContextLimit,
    providerContextLimit: modelCapability.providerContextLimit,
    providerOutputLimit: modelCapability.providerOutputLimit,
    modelLoaded: modelCapability.loaded,
    preserveAssistantReasoning:
      modelCapability.preserveAssistantReasoning,
    availableMemoryBytes,
  });
}
