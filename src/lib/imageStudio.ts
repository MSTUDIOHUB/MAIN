import {
  checkImageStudioEngine,
  listenImageStudioStreamChunk,
  listenImageStudioStreamDone,
  proxyImageStudioRequest,
  saveImageStudioOutput,
  saveImageStudioRemoteOutput,
  type ImageStudioStreamDonePayload,
} from "./ipc";

export type ImageStudioProviderKind = "local_image_service" | "web_fallback";
export type ImageStudioProtocol = "openai_images";
export type ImageStudioLocalServiceFamily = "openai_compatible" | "ollama" | "omlx";
export type ImageStudioAspectRatio = "1:1" | "3:4" | "4:3" | "16:9" | "9:16" | "3:2" | "2:3" | "21:9" | "9:21" | "9:7" | "7:9";
export type ImageStudioSeedMode = "random" | "fixed";
export type ImageStudioProviderState = "unknown" | "ready" | "missing" | "error";
export type ImageGenerationStatus = "queued" | "running" | "completed" | "error" | "canceled";

export interface ImageStudioProviderCapabilities {
  textToImage: boolean;
  imageToImage: boolean;
  progressPreview: boolean;
  cloudHosted?: boolean;
  modelDiscovery?: boolean;
}

export interface LocalImageStudioProviderConfig {
  endpoint: string;
  model: string;
  protocol: ImageStudioProtocol;
  serviceFamily: ImageStudioLocalServiceFamily;
}

export interface WebFallbackImageStudioProviderConfig {
  endpoint: string;
  promptRefine: boolean;
  enabled: boolean;
}

export interface ImageStudioRuntimeConfig {
  provider: ImageStudioProviderKind;
  local: LocalImageStudioProviderConfig;
  web: WebFallbackImageStudioProviderConfig;
  defaultSize: { width: number; height: number };
  aspectRatio: ImageStudioAspectRatio;
  steps: number;
  guidanceScale: number;
  seedMode: ImageStudioSeedMode;
  seed: number;
  outputDirectory: string;
}

export interface ImageStudioProviderStatus {
  providerKind: ImageStudioProviderKind;
  state: ImageStudioProviderState;
  message: string;
  capabilities: ImageStudioProviderCapabilities;
  checkedAt?: number;
  discoveredModels?: string[];
  activeModel?: string;
}

export interface ImageStudioRuntime {
  config: ImageStudioRuntimeConfig;
  status: ImageStudioProviderStatus;
  setupGuideOpen: boolean;
  activeJobId: string | null;
  activeStreamId: string | null;
  cooldownUntil?: number;
}

export interface ImageGenerationParams {
  providerKind: ImageStudioProviderKind;
  endpoint: string;
  model?: string;
  protocol?: ImageStudioProtocol;
  width: number;
  height: number;
  aspectRatio: ImageStudioAspectRatio;
  steps: number;
  guidanceScale: number;
  promptRefine: boolean;
  seed: number;
  seedMode: ImageStudioSeedMode;
}

export interface ImageGenerationProgress {
  stage: "queued" | "starting" | "generating" | "saving" | "done" | "error" | "canceled";
  step: number;
  total: number;
  percent: number;
  message: string;
}

export interface ImageGenerationBlockPayload {
  type: "imageGeneration";
  status: ImageGenerationStatus;
  prompt: string;
  params: ImageGenerationParams;
  providerKind: ImageStudioProviderKind;
  model?: string;
  variantGroupId?: string;
  progress: ImageGenerationProgress;
  previewUrl?: string;
  imageUrl?: string;
  outputPath?: string;
  jobId?: string;
  streamId?: string;
  error?: string;
}

// Compatibility aliases while older call sites migrate.
export type ImageStudioEngineKey = ImageStudioProviderKind;
export type ImageStudioEngineState = ImageStudioProviderState;
export type ImageStudioConfig = ImageStudioRuntimeConfig;
export type ImageStudioEngineStatus = ImageStudioProviderStatus;

export const IMAGE_STUDIO_WEB_FALLBACK_ENDPOINT = "https://hidream-ai-hidream-o1-image-dev.hf.space";
export const IMAGE_STUDIO_WEB_FALLBACK_PAGE = "https://huggingface.co/spaces/HiDream-ai/HiDream-O1-Image-Dev";
export const IMAGE_STUDIO_LOCAL_DEFAULT_ENDPOINT = "http://127.0.0.1:8000/v1";
export const IMAGE_STUDIO_DEFAULT_ENDPOINT = IMAGE_STUDIO_LOCAL_DEFAULT_ENDPOINT;

// Legacy exports kept for persisted migrations and existing imports.
export const IMAGE_STUDIO_HF_SPACE_ENDPOINT = IMAGE_STUDIO_WEB_FALLBACK_ENDPOINT;
export const IMAGE_STUDIO_HF_SPACE_PAGE = IMAGE_STUDIO_WEB_FALLBACK_PAGE;
export const IMAGE_STUDIO_HIDREAM_HTTP_ENDPOINT = IMAGE_STUDIO_LOCAL_DEFAULT_ENDPOINT;

function getDefaultImageStudioCapabilities(providerKind: ImageStudioProviderKind): ImageStudioProviderCapabilities {
  if (providerKind === "web_fallback") {
    return {
      textToImage: true,
      imageToImage: false,
      progressPreview: false,
      cloudHosted: true,
      modelDiscovery: false,
    };
  }
  return {
    textToImage: true,
    imageToImage: false,
    progressPreview: false,
    cloudHosted: false,
    modelDiscovery: true,
  };
}

export function getDefaultImageStudioEndpoint(providerKind: ImageStudioProviderKind): string {
  return providerKind === "web_fallback" ? IMAGE_STUDIO_WEB_FALLBACK_ENDPOINT : IMAGE_STUDIO_LOCAL_DEFAULT_ENDPOINT;
}

export function getDefaultImageStudioEndpointForServiceFamily(
  serviceFamily: ImageStudioLocalServiceFamily,
): string {
  return serviceFamily === "ollama"
    ? "http://127.0.0.1:11434/v1"
    : IMAGE_STUDIO_LOCAL_DEFAULT_ENDPOINT;
}

export function mapLocalModelProviderToImageStudioServiceFamily(
  provider: unknown,
): ImageStudioLocalServiceFamily {
  if (provider === "Ollama" || provider === "ollama") return "ollama";
  if (provider === "OMLX" || provider === "omlx") return "omlx";
  return "openai_compatible";
}

export function isLocalImageStudioProvider(
  configOrKind: ImageStudioRuntimeConfig | ImageStudioProviderKind | null | undefined,
): boolean {
  const kind = typeof configOrKind === "string"
    ? configOrKind
    : normalizeImageStudioConfig(configOrKind).provider;
  return kind === "local_image_service";
}

export function isWebFallbackImageStudioProvider(
  configOrKind: ImageStudioRuntimeConfig | ImageStudioProviderKind | null | undefined,
): boolean {
  const kind = typeof configOrKind === "string"
    ? configOrKind
    : normalizeImageStudioConfig(configOrKind).provider;
  return kind === "web_fallback";
}

export function getActiveImageStudioEndpoint(config: ImageStudioRuntimeConfig): string {
  const normalized = normalizeImageStudioConfig(config);
  return normalized.provider === "web_fallback"
    ? normalized.web.endpoint
    : normalized.local.endpoint;
}

export function getActiveImageStudioModel(config: ImageStudioRuntimeConfig): string {
  const normalized = normalizeImageStudioConfig(config);
  return normalized.provider === "local_image_service" ? normalized.local.model.trim() : "";
}

export function createDefaultImageStudioConfig(): ImageStudioRuntimeConfig {
  return {
    provider: "local_image_service",
    local: {
      endpoint: IMAGE_STUDIO_LOCAL_DEFAULT_ENDPOINT,
      model: "",
      protocol: "openai_images",
      serviceFamily: "omlx",
    },
    web: {
      endpoint: IMAGE_STUDIO_WEB_FALLBACK_ENDPOINT,
      promptRefine: true,
      enabled: true,
    },
    defaultSize: { width: 1024, height: 1024 },
    aspectRatio: "1:1",
    steps: 28,
    guidanceScale: 0,
    seedMode: "random",
    seed: 32,
    outputDirectory: "",
  };
}

export function createDefaultImageStudioStatus(): ImageStudioProviderStatus {
  return {
    providerKind: "local_image_service",
    state: "unknown",
    message: "Local image service has not been checked yet.",
    capabilities: getDefaultImageStudioCapabilities("local_image_service"),
    discoveredModels: [],
    activeModel: "",
  };
}

export function createDefaultImageStudioRuntime(): ImageStudioRuntime {
  return {
    config: createDefaultImageStudioConfig(),
    status: createDefaultImageStudioStatus(),
    setupGuideOpen: false,
    activeJobId: null,
    activeStreamId: null,
    cooldownUntil: 0,
  };
}

export function normalizeImageStudioConfig(input: unknown): ImageStudioRuntimeConfig {
  const fallback = createDefaultImageStudioConfig();
  const raw = input && typeof input === "object" ? input as Partial<ImageStudioRuntimeConfig> & Record<string, unknown> : {};
  const legacyEngine = raw.engine === "hidream_http" || raw.engine === "huggingface_space"
    ? raw.engine
    : null;
  const provider = normalizeProviderKind(raw.provider, legacyEngine);
  const legacyEndpoint = typeof raw.endpoint === "string" ? raw.endpoint : "";
  const legacyPromptRefine = raw.promptRefine === false ? false : true;
  const legacyModel = typeof raw.model === "string" ? raw.model : "";
  const localRaw = raw.local && typeof raw.local === "object" ? raw.local as Partial<LocalImageStudioProviderConfig> : {};
  const webRaw = raw.web && typeof raw.web === "object" ? raw.web as Partial<WebFallbackImageStudioProviderConfig> : {};
  const size = raw.defaultSize && typeof raw.defaultSize === "object" ? raw.defaultSize : fallback.defaultSize;
  const webEnabled = webRaw.enabled !== false;

  const migratedLegacyEndpoint = legacyEndpoint.trim().replace(/\/+$/, "");
  const localEndpointFromLegacy = legacyEngine === "hidream_http" && migratedLegacyEndpoint
    ? migratedLegacyEndpoint
    : fallback.local.endpoint;
  const webEndpointFromLegacy = legacyEngine === "huggingface_space" && migratedLegacyEndpoint
    ? migratedLegacyEndpoint
    : fallback.web.endpoint;

  return {
    provider: provider === "web_fallback" && !webEnabled ? "local_image_service" : provider,
    local: {
      endpoint: normalizeEndpointString(localRaw.endpoint, localEndpointFromLegacy),
      model: normalizeText(localRaw.model, legacyEngine === "hidream_http" ? legacyModel : fallback.local.model),
      protocol: localRaw.protocol === "openai_images" ? "openai_images" : fallback.local.protocol,
      serviceFamily: normalizeLocalImageServiceFamily(localRaw.serviceFamily, fallback.local.serviceFamily),
    },
    web: {
      endpoint: normalizeEndpointString(webRaw.endpoint, webEndpointFromLegacy),
      promptRefine: typeof webRaw.promptRefine === "boolean" ? webRaw.promptRefine : legacyPromptRefine,
      enabled: webEnabled,
    },
    defaultSize: {
      width: clampNumber((size as { width?: unknown }).width, 512, 2048, fallback.defaultSize.width),
      height: clampNumber((size as { height?: unknown }).height, 512, 2048, fallback.defaultSize.height),
    },
    aspectRatio: normalizeAspectRatio(raw.aspectRatio),
    steps: clampNumber(raw.steps, 1, 80, fallback.steps),
    guidanceScale: clampNumber(raw.guidanceScale, 0, 20, fallback.guidanceScale),
    seedMode: raw.seedMode === "fixed" ? "fixed" : "random",
    seed: clampNumber(raw.seed, 0, 2147483647, fallback.seed),
    outputDirectory: typeof raw.outputDirectory === "string" ? raw.outputDirectory : "",
  };
}

export function normalizeImageStudioStatus(input: unknown): ImageStudioProviderStatus {
  const fallback = createDefaultImageStudioStatus();
  const raw = input && typeof input === "object" ? input as Partial<ImageStudioProviderStatus> & Record<string, unknown> : {};
  const legacyProviderKind = raw.providerKind === "local_image_service" || raw.providerKind === "web_fallback"
    ? raw.providerKind
    : raw.capabilities && typeof raw.capabilities === "object" && raw.capabilities
      ? ((((raw.capabilities as unknown as Record<string, unknown>).cloudHosted) === true) ? "web_fallback" : "local_image_service")
      : fallback.providerKind;
  const state = raw.state === "ready" || raw.state === "missing" || raw.state === "error" || raw.state === "unknown"
    ? raw.state
    : fallback.state;
  return {
    providerKind: legacyProviderKind,
    state,
    message: typeof raw.message === "string" && raw.message.trim() ? raw.message : fallback.message,
    capabilities: {
      ...getDefaultImageStudioCapabilities(legacyProviderKind),
      ...(raw.capabilities && typeof raw.capabilities === "object" ? raw.capabilities : {}),
    },
    checkedAt: typeof raw.checkedAt === "number" ? raw.checkedAt : undefined,
    discoveredModels: normalizeStringArray(raw.discoveredModels),
    activeModel: typeof raw.activeModel === "string" ? raw.activeModel : "",
  };
}

export function normalizeImageStudioRuntime(input: unknown): ImageStudioRuntime {
  const raw = input && typeof input === "object" ? input as Partial<ImageStudioRuntime> : {};
  const config = normalizeImageStudioConfig(raw.config);
  const status = normalizeImageStudioStatus(raw.status);
  return {
    config,
    status: {
      ...status,
      providerKind: status.providerKind || config.provider,
      activeModel: status.activeModel || getActiveImageStudioModel(config),
    },
    setupGuideOpen: raw.setupGuideOpen === true,
    activeJobId: typeof raw.activeJobId === "string" ? raw.activeJobId : null,
    activeStreamId: typeof raw.activeStreamId === "string" ? raw.activeStreamId : null,
    cooldownUntil: typeof raw.cooldownUntil === "number" ? raw.cooldownUntil : 0,
  };
}

export function resolveImageStudioSize(config: ImageStudioRuntimeConfig): { width: number; height: number } {
  const base = normalizeImageStudioConfig(config);
  switch (base.aspectRatio) {
    case "3:4":
      return { width: 896, height: 1152 };
    case "4:3":
      return { width: 1152, height: 896 };
    case "16:9":
      return { width: 1344, height: 768 };
    case "9:16":
      return { width: 768, height: 1344 };
    case "3:2":
      return { width: 1216, height: 832 };
    case "2:3":
      return { width: 832, height: 1216 };
    case "21:9":
      return { width: 1536, height: 640 };
    case "9:21":
      return { width: 640, height: 1536 };
    case "9:7":
      return { width: 1152, height: 896 };
    case "7:9":
      return { width: 896, height: 1152 };
    case "1:1":
    default:
      return { width: base.defaultSize.width, height: base.defaultSize.height };
  }
}

export function buildImageGenerationParams(config: ImageStudioRuntimeConfig): ImageGenerationParams {
  const normalized = normalizeImageStudioConfig(config);
  const size = resolveImageStudioSize(normalized);
  const randomSeed = Math.floor(Math.random() * 2147483647);
  const model = getActiveImageStudioModel(normalized);
  return {
    providerKind: normalized.provider,
    endpoint: getActiveImageStudioEndpoint(normalized),
    ...(model ? { model } : {}),
    ...(normalized.provider === "local_image_service" ? { protocol: normalized.local.protocol } : {}),
    width: size.width,
    height: size.height,
    aspectRatio: normalized.aspectRatio,
    steps: normalized.steps,
    guidanceScale: normalized.guidanceScale,
    promptRefine: normalized.web.promptRefine,
    seedMode: normalized.seedMode,
    seed: normalized.seedMode === "fixed" ? normalized.seed : randomSeed,
  };
}

export function createInitialImageProgress(): ImageGenerationProgress {
  return {
    stage: "queued",
    step: 0,
    total: 0,
    percent: 0,
    message: "Queued",
  };
}

export async function discoverLocalImageStudioModels(input: {
  endpoint: string;
  serviceFamily?: ImageStudioLocalServiceFamily;
} | string): Promise<string[]> {
  const endpoint = typeof input === "string" ? input : input.endpoint;
  const serviceFamily = typeof input === "string"
    ? "openai_compatible"
    : normalizeLocalImageServiceFamily(input.serviceFamily, "openai_compatible");
  const trimmed = normalizeEndpointString(endpoint, IMAGE_STUDIO_LOCAL_DEFAULT_ENDPOINT);
  const candidates = serviceFamily === "ollama"
    ? buildOllamaModelDiscoveryCandidates(trimmed)
    : buildOpenAiModelDiscoveryCandidates(trimmed);

  for (const candidate of candidates) {
    const response = await proxyImageStudioRequest({
      engine: "local_image_service",
      endpoint: trimmed,
      path: candidate.path,
      method: "GET",
    }).catch(() => null);
    if (!response?.ok) continue;
    const payload = parseJsonValue(response.body);
    const models = serviceFamily === "ollama"
      ? extractOllamaModelIds(payload)
      : extractOpenAiModelIds(payload);
    if (models.length > 0) return models;
  }

  throw new Error("Local image service model discovery failed.");
}

export function isImageModelName(modelName: string): boolean {
  if (!modelName) return false;
  const name = modelName.toLowerCase();
  const imageKeywords = [
    "flux",
    "stable-diffusion",
    "diffusion",
    "sdxl",
    "sd15",
    "sd21",
    "sd-",
    "sd3",
    "sd_",
    "kolors",
    "dall-e",
    "dalle",
    "midjourney",
    "playground",
    "pixart",
    "auraflow",
    "hunyuan-dit",
    "cogview",
    "janus",
    "showui"
  ];
  const textKeywords = [
    "qwen",
    "gemma",
    "llama",
    "deepseek",
    "mistral",
    "phi",
    "yi",
    "chatglm",
    "internlm",
    "baichuan",
    "mixtral",
    "gemma2",
    "gemma4"
  ];

  if (imageKeywords.some(kw => name.includes(kw))) {
    return true;
  }
  if (textKeywords.some(kw => name.includes(kw))) {
    return false;
  }
  return false;
}

export async function checkImageStudioEngineStatus(config: ImageStudioRuntimeConfig): Promise<ImageStudioProviderStatus> {
  const normalized = normalizeImageStudioConfig(config);
  const providerKind = normalized.provider;
  if (providerKind === "web_fallback" && normalized.web.enabled === false) {
    return normalizeImageStudioStatus({
      providerKind,
      state: "missing",
      message: "HiDream Web fallback is disabled in Image Studio settings.",
      capabilities: getDefaultImageStudioCapabilities(providerKind),
      checkedAt: Date.now(),
      activeModel: getActiveImageStudioModel(normalized),
    });
  }
  try {
    const result = await checkImageStudioEngine({
      engine: providerKind,
      endpoint: getActiveImageStudioEndpoint(normalized),
    });
    const models = providerKind === "local_image_service"
      ? await discoverLocalImageStudioModels({
          endpoint: normalized.local.endpoint,
          serviceFamily: normalized.local.serviceFamily,
        }).catch(() => [])
      : [];
    const localDiscoveryReady = providerKind === "local_image_service" && models.length > 0;
    const ready = localDiscoveryReady || result.ready;

    const activeModel = getActiveImageStudioModel(normalized);
    let warningSuffix = "";
    if (providerKind === "local_image_service" && activeModel && !isImageModelName(activeModel)) {
      warningSuffix = ` (警告: 当前选择的模型 '${activeModel}' 可能是文本模型，非生图模型，请确保您的本地服务支持生图)。`;
    }

    const baseMessage = localDiscoveryReady && !result.ready
      ? `Discovered ${models.length} local model${models.length === 1 ? "" : "s"} through ${normalized.local.serviceFamily}.`
      : result.message || (
          ready
            ? providerKind === "local_image_service"
              ? "Local image service is reachable."
              : "Web fallback image provider is reachable."
            : "Image provider is not reachable."
        );

    return normalizeImageStudioStatus({
      providerKind,
      state: ready ? "ready" : "missing",
      message: baseMessage + warningSuffix,
      capabilities: {
        ...getDefaultImageStudioCapabilities(providerKind),
        ...(result.capabilities || {}),
      },
      checkedAt: Date.now(),
      discoveredModels: models,
      activeModel: getActiveImageStudioModel(normalized),
    });
  } catch (error) {
    return normalizeImageStudioStatus({
      providerKind,
      state: "error",
      message: error instanceof Error ? error.message : String(error || "Image provider check failed."),
      capabilities: getDefaultImageStudioCapabilities(providerKind),
      checkedAt: Date.now(),
      activeModel: getActiveImageStudioModel(normalized),
    });
  }
}

export async function runLocalImageStudioGeneration(params: {
  prompt: string;
  config: ImageStudioRuntimeConfig;
  generationParams: ImageGenerationParams;
  referenceImages?: string[];
}): Promise<{ imageUrl: string }> {
  if (params.referenceImages && params.referenceImages.length > 0) {
    throw new Error("The configured local image service does not expose image-to-image in MAIN v1.");
  }
  const normalized = normalizeImageStudioConfig(params.config);
  const body = {
    prompt: params.prompt,
    ...(params.generationParams.model ? { model: params.generationParams.model } : {}),
    n: 1,
    response_format: "b64_json",
    size: `${params.generationParams.width}x${params.generationParams.height}`,
    width: params.generationParams.width,
    height: params.generationParams.height,
    seed: params.generationParams.seed,
    steps: params.generationParams.steps,
    guidance_scale: params.generationParams.guidanceScale,
  };
  const response = await proxyImageStudioRequest({
    engine: normalized.provider,
    endpoint: normalized.local.endpoint,
    path: "/v1/images/generations",
    method: "POST",
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(`Local image generation failed with HTTP ${response.status}: ${response.body.slice(0, 240)}`);
  }
  const imageUrl = extractOpenAiImageResult(parseJsonValue(response.body));
  if (!imageUrl) {
    throw new Error("The local image service did not return image data.");
  }
  return { imageUrl };
}

export async function startWebFallbackGeneration(params: {
  prompt: string;
  config: ImageStudioRuntimeConfig;
  generationParams: ImageGenerationParams;
  referenceImages?: string[];
}): Promise<{ jobId: string }> {
  if (params.referenceImages && params.referenceImages.length > 0) {
    throw new Error("The web fallback provider supports text-to-image only in MAIN v1.");
  }
  const normalized = normalizeImageStudioConfig(params.config);
  const body = {
    data: [
      params.prompt,
      params.generationParams.aspectRatio,
      normalized.web.promptRefine,
      params.generationParams.seedMode === "random" ? -1 : params.generationParams.seed,
    ],
  };
  const response = await proxyImageStudioRequest({
    engine: "web_fallback",
    endpoint: normalized.web.endpoint,
    path: "/gradio_api/call/_generate_wrapped",
    method: "POST",
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(`Web fallback start failed with HTTP ${response.status}: ${response.body.slice(0, 240)}`);
  }
  const payload = parseJsonValue(response.body) || {};
  const jobId = String(payload.event_id || payload.eventId || payload.job_id || payload.jobId || "");
  if (!jobId) throw new Error("The web fallback provider did not return an event id.");
  return { jobId };
}

export async function startImageStudioGeneration(params: {
  prompt: string;
  config: ImageStudioRuntimeConfig;
  generationParams: ImageGenerationParams;
  referenceImages?: string[];
}): Promise<{ jobId: string }> {
  const normalized = normalizeImageStudioConfig(params.config);
  if (normalized.provider === "local_image_service") {
    throw new Error("Local image service generation is synchronous; call runLocalImageStudioGeneration instead.");
  }
  return startWebFallbackGeneration(params);
}

export async function streamWebFallbackGeneration(params: {
  config: ImageStudioRuntimeConfig;
  jobId: string;
  streamId: string;
  onProgress: (event: ImageGenerationProgress & { previewUrl?: string }) => void;
  onDone: (payload: { imageUrl?: string; error?: string; canceled?: boolean }) => Promise<void> | void;
}): Promise<() => void> {
  let closed = false;
  let deliveredFinalResult = false;
  let sseBuffer = "";
  const cleanupFns: Array<() => void> = [];
  const startedAt = Date.now();
  const normalized = normalizeImageStudioConfig(params.config);

  const handleSseEvents = (events: string[]) => {
    for (const event of events) {
      const data = parseJsonValue(event);
      if (Array.isArray(data)) {
        const image = data[0] && typeof data[0] === "object" ? data[0] as Record<string, any> : null;
        const message = normalizeGradioStatusMessage(typeof data[1] === "string" ? data[1] : "");
        if (image && typeof image.url === "string" && image.url) {
          deliveredFinalResult = true;
          void params.onDone({ imageUrl: image.url });
          continue;
        }
        const seconds = Math.max(0, Math.round((Date.now() - startedAt) / 1000));
        params.onProgress({
          stage: message.toLowerCase().includes("downloading") ? "saving" : "generating",
          step: seconds,
          total: 0,
          percent: inferHostedProgressPercent(message, seconds),
          message: message || `Generating ${seconds}s`,
        });
      } else if (data && typeof data === "object") {
        const record = data as Record<string, any>;
        if (record.error || record.msg) {
          deliveredFinalResult = true;
          void params.onDone({ error: String(record.error || record.msg || "Web fallback image generation failed.") });
        }
      }
    }
  };

  cleanupFns.push(await listenImageStudioStreamChunk((payload) => {
    if (closed || payload.streamId !== params.streamId) return;
    const parsed = extractSseEvents(sseBuffer + payload.chunk);
    sseBuffer = parsed.remainder;
    handleSseEvents(parsed.events);
  }));

  cleanupFns.push(await listenImageStudioStreamDone((payload: ImageStudioStreamDonePayload) => {
    if (closed || payload.streamId !== params.streamId) return;
    if (sseBuffer.trim()) {
      const parsed = extractSseEvents(`${sseBuffer}\n\n`);
      sseBuffer = "";
      handleSseEvents(parsed.events);
    }
    if (payload.status === "cancelled") {
      deliveredFinalResult = true;
      void params.onDone({ canceled: true });
    } else if (payload.status === "error") {
      deliveredFinalResult = true;
      void params.onDone({ error: payload.error || "Web fallback image stream failed." });
    } else if (!deliveredFinalResult) {
      void params.onDone({ error: "Web fallback image stream ended before a final image was returned." });
    }
  }));

  void proxyImageStudioRequest({
    engine: normalized.provider,
    endpoint: normalized.web.endpoint,
    path: `/gradio_api/call/_generate_wrapped/${encodeURIComponent(params.jobId)}`,
    method: "GET",
    streamId: params.streamId,
  }).catch((error) => {
    if (!closed) {
      void params.onDone({ error: error instanceof Error ? error.message : String(error || "Web fallback image stream failed.") });
    }
  });

  return () => {
    closed = true;
    for (const cleanup of cleanupFns) cleanup();
  };
}

export async function streamImageStudioGeneration(params: {
  config: ImageStudioRuntimeConfig;
  jobId: string;
  streamId: string;
  onProgress: (event: ImageGenerationProgress & { previewUrl?: string }) => void;
  onDone: (payload: { imageUrl?: string; error?: string; canceled?: boolean }) => Promise<void> | void;
}): Promise<() => void> {
  const normalized = normalizeImageStudioConfig(params.config);
  if (normalized.provider === "local_image_service") {
    throw new Error("Local image service generation does not use streaming jobs in MAIN v1.");
  }
  return streamWebFallbackGeneration(params);
}

export async function persistGeneratedImage(params: {
  sessionKey: string;
  prompt: string;
  imageUrl: string;
}): Promise<string> {
  const safeName = params.prompt
    .trim()
    .replace(/[^a-z0-9\u4e00-\u9fa5_-]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "image";
  if (/^https?:\/\//i.test(params.imageUrl.trim())) {
    return saveImageStudioRemoteOutput(params.sessionKey, `${Date.now()}-${safeName}.png`, params.imageUrl);
  }
  return saveImageStudioOutput(params.sessionKey, `${Date.now()}-${safeName}.png`, params.imageUrl);
}

function normalizeProviderKind(
  value: unknown,
  legacyEngine?: "hidream_http" | "huggingface_space" | null,
): ImageStudioProviderKind {
  if (value === "local_image_service" || value === "web_fallback") return value;
  if (legacyEngine === "huggingface_space") return "web_fallback";
  return "local_image_service";
}

function normalizeEndpointString(value: unknown, fallback: string): string {
  const normalized = typeof value === "string" ? value.trim().replace(/\/+$/, "") : "";
  return normalized || fallback.replace(/\/+$/, "");
}

function normalizeText(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value.trim() : fallback;
}

function normalizeLocalImageServiceFamily(
  value: unknown,
  fallback: ImageStudioLocalServiceFamily = "openai_compatible",
): ImageStudioLocalServiceFamily {
  return value === "ollama" || value === "omlx" || value === "openai_compatible"
    ? value
    : fallback;
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const next: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    const normalized = item.trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    next.push(normalized);
  }
  return next;
}

function extractOpenAiModelIds(payload: unknown): string[] {
  if (!payload || typeof payload !== "object") return [];
  const data = (payload as { data?: unknown }).data;
  if (!Array.isArray(data)) return [];
  return normalizeStringArray(
    data
      .map((item) => item && typeof item === "object" ? (item as { id?: unknown }).id : "")
      .filter((item): item is string => typeof item === "string"),
  );
}

function extractOllamaModelIds(payload: unknown): string[] {
  if (!payload || typeof payload !== "object") return [];
  const models = (payload as { models?: unknown }).models;
  if (!Array.isArray(models)) return [];
  return normalizeStringArray(
    models
      .map((item) => {
        if (!item || typeof item !== "object") return "";
        const record = item as Record<string, unknown>;
        return typeof record.name === "string"
          ? record.name
          : typeof record.model === "string"
          ? record.model
          : "";
      })
      .filter((item): item is string => typeof item === "string"),
  );
}

function extractOpenAiImageResult(payload: unknown): string {
  if (!payload || typeof payload !== "object") return "";
  const data = (payload as { data?: unknown }).data;
  if (!Array.isArray(data) || data.length === 0) return "";
  const first = data[0];
  if (!first || typeof first !== "object") return "";
  const record = first as Record<string, unknown>;
  if (typeof record.b64_json === "string" && record.b64_json.trim()) {
    return `data:image/png;base64,${record.b64_json.trim()}`;
  }
  if (typeof record.url === "string" && record.url.trim()) {
    return record.url.trim();
  }
  if (typeof record.b64 === "string" && record.b64.trim()) {
    return `data:image/png;base64,${record.b64.trim()}`;
  }
  return "";
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

function normalizeAspectRatio(value: unknown): ImageStudioAspectRatio {
  return value === "3:4" || value === "4:3" || value === "16:9" || value === "9:16" || value === "3:2" || value === "2:3" || value === "21:9" || value === "9:21" || value === "9:7" || value === "7:9" || value === "1:1"
    ? value
    : "1:1";
}

function buildOpenAiModelDiscoveryCandidates(endpoint: string): Array<{ path: string }> {
  return endpoint.endsWith("/v1")
    ? [{ path: "/v1/models" }, { path: "/models" }]
    : [{ path: "/v1/models" }, { path: "/models" }];
}

function buildOllamaModelDiscoveryCandidates(endpoint: string): Array<{ path: string }> {
  const normalized = endpoint.replace(/\/+$/, "");
  return normalized.endsWith("/v1")
    ? [{ path: "/api/tags" }, { path: "/api/ps" }, { path: "/v1/models" }]
    : [{ path: "/api/tags" }, { path: "/api/ps" }, { path: "/v1/models" }];
}

function extractSseEvents(text: string): { events: string[]; remainder: string } {
  const normalized = String(text || "").replace(/\r\n/g, "\n");
  const chunks = normalized.split(/\n\n+/);
  const hasTerminator = /\n\n+$/.test(normalized);
  const completeParts = hasTerminator ? chunks : chunks.slice(0, -1);
  const remainder = hasTerminator ? "" : chunks[chunks.length - 1] || "";
  return {
    events: completeParts
      .map((part) => part
        .split(/\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim())
        .join("\n")
        .trim())
      .filter(Boolean),
    remainder,
  };
}

function parseJsonValue(value: string): any {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function normalizeGradioStatusMessage(html: string): string {
  return String(html || "")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&middot;/g, "·")
    .replace(/\s+/g, " ")
    .trim();
}

function inferHostedProgressPercent(message: string, seconds: number): number {
  const normalized = message.toLowerCase();
  if (normalized.includes("sending")) return 4;
  if (normalized.includes("submitted")) return 8;
  if (normalized.includes("downloading")) return 94;
  if (normalized.includes("generated")) return 100;
  return Math.max(12, Math.min(90, 12 + Math.floor(seconds * 2.6)));
}

export function isImageGenerationPrompt(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.startsWith("/") && (
    trimmed.startsWith("/image") || 
    trimmed.startsWith("/draw") || 
    trimmed.startsWith("/生图") || 
    trimmed.startsWith("/画图")
  )) {
    return true;
  }
  const zhPatterns = [
    /^(?:画图|生图|生成图片|画一张|画一幅|画个|画一只|画幅|画张)[:：\s]/i,
    /^(?:请|帮我|帮我画|给我画)?(?:画(?:一个|一只|一幅|一张|个|只|幅|张|起)?|生成(?:一张|一幅|个)?图片)(?!.*(?:怎么|代码|方法|逻辑|步骤|教程|过程))/
  ];
  const enPatterns = [
    /^(?:draw|paint|generate image|create image|generate a picture of|generate an image of|make an image of)[:\s]/i,
    /^(?:please |could you )?(?:draw|paint|generate|create|make) (?:a |an )?(?:image|picture|painting|photo|drawing) of (?!.*(?:how to|code|tutorial|steps|process|program))/i
  ];
  return zhPatterns.some(p => p.test(trimmed)) || enPatterns.some(p => p.test(trimmed));
}
