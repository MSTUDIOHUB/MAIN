import {
  checkImageStudioEngine,
  listenImageStudioStreamChunk,
  listenImageStudioStreamDone,
  proxyImageStudioRequest,
  saveImageStudioOutput,
  type ImageStudioStreamDonePayload,
} from "./ipc";

export type ImageStudioEngineKey = "hidream_http";
export type ImageStudioAspectRatio = "1:1" | "3:4" | "4:3" | "16:9" | "9:16";
export type ImageStudioSeedMode = "random" | "fixed";
export type ImageStudioEngineState = "unknown" | "ready" | "missing" | "error";
export type ImageGenerationStatus = "queued" | "running" | "completed" | "error" | "canceled";

export interface ImageStudioConfig {
  engine: ImageStudioEngineKey;
  endpoint: string;
  defaultSize: { width: number; height: number };
  aspectRatio: ImageStudioAspectRatio;
  steps: number;
  guidanceScale: number;
  seedMode: ImageStudioSeedMode;
  seed: number;
  outputDirectory: string;
}

export interface ImageStudioEngineStatus {
  state: ImageStudioEngineState;
  message: string;
  capabilities: {
    textToImage: boolean;
    imageToImage: boolean;
    progressPreview: boolean;
    cudaRequired: boolean;
  };
  checkedAt?: number;
}

export interface ImageStudioRuntime {
  config: ImageStudioConfig;
  status: ImageStudioEngineStatus;
  setupGuideOpen: boolean;
  activeJobId: string | null;
  activeStreamId: string | null;
}

export interface ImageGenerationParams {
  engine: ImageStudioEngineKey;
  endpoint: string;
  width: number;
  height: number;
  aspectRatio: ImageStudioAspectRatio;
  steps: number;
  guidanceScale: number;
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
  progress: ImageGenerationProgress;
  previewUrl?: string;
  imageUrl?: string;
  outputPath?: string;
  jobId?: string;
  streamId?: string;
  error?: string;
}

export const IMAGE_STUDIO_DEFAULT_ENDPOINT = "http://127.0.0.1:7860";

const DEFAULT_CAPABILITIES = {
  textToImage: true,
  imageToImage: true,
  progressPreview: true,
  cudaRequired: true,
};

export function createDefaultImageStudioConfig(): ImageStudioConfig {
  return {
    engine: "hidream_http",
    endpoint: IMAGE_STUDIO_DEFAULT_ENDPOINT,
    defaultSize: { width: 1024, height: 1024 },
    aspectRatio: "1:1",
    steps: 28,
    guidanceScale: 5,
    seedMode: "random",
    seed: 32,
    outputDirectory: "",
  };
}

export function createDefaultImageStudioStatus(): ImageStudioEngineStatus {
  return {
    state: "unknown",
    message: "Image engine has not been checked yet.",
    capabilities: DEFAULT_CAPABILITIES,
  };
}

export function createDefaultImageStudioRuntime(): ImageStudioRuntime {
  return {
    config: createDefaultImageStudioConfig(),
    status: createDefaultImageStudioStatus(),
    setupGuideOpen: false,
    activeJobId: null,
    activeStreamId: null,
  };
}

export function normalizeImageStudioConfig(input: unknown): ImageStudioConfig {
  const fallback = createDefaultImageStudioConfig();
  const raw = input && typeof input === "object" ? input as Partial<ImageStudioConfig> : {};
  const size = raw.defaultSize && typeof raw.defaultSize === "object" ? raw.defaultSize : fallback.defaultSize;
  return {
    engine: raw.engine === "hidream_http" ? raw.engine : fallback.engine,
    endpoint: typeof raw.endpoint === "string" && raw.endpoint.trim()
      ? raw.endpoint.trim().replace(/\/+$/, "")
      : fallback.endpoint,
    defaultSize: {
      width: clampNumber(size.width, 512, 2048, fallback.defaultSize.width),
      height: clampNumber(size.height, 512, 2048, fallback.defaultSize.height),
    },
    aspectRatio: normalizeAspectRatio(raw.aspectRatio),
    steps: clampNumber(raw.steps, 1, 80, fallback.steps),
    guidanceScale: clampNumber(raw.guidanceScale, 0, 20, fallback.guidanceScale),
    seedMode: raw.seedMode === "fixed" ? "fixed" : "random",
    seed: clampNumber(raw.seed, 0, 2147483647, fallback.seed),
    outputDirectory: typeof raw.outputDirectory === "string" ? raw.outputDirectory : "",
  };
}

export function normalizeImageStudioStatus(input: unknown): ImageStudioEngineStatus {
  const fallback = createDefaultImageStudioStatus();
  const raw = input && typeof input === "object" ? input as Partial<ImageStudioEngineStatus> : {};
  const state = raw.state === "ready" || raw.state === "missing" || raw.state === "error" || raw.state === "unknown"
    ? raw.state
    : fallback.state;
  return {
    state,
    message: typeof raw.message === "string" && raw.message.trim() ? raw.message : fallback.message,
    capabilities: {
      ...DEFAULT_CAPABILITIES,
      ...(raw.capabilities && typeof raw.capabilities === "object" ? raw.capabilities : {}),
    },
    checkedAt: typeof raw.checkedAt === "number" ? raw.checkedAt : undefined,
  };
}

export function normalizeImageStudioRuntime(input: unknown): ImageStudioRuntime {
  const raw = input && typeof input === "object" ? input as Partial<ImageStudioRuntime> : {};
  return {
    config: normalizeImageStudioConfig(raw.config),
    status: normalizeImageStudioStatus(raw.status),
    setupGuideOpen: raw.setupGuideOpen === true,
    activeJobId: typeof raw.activeJobId === "string" ? raw.activeJobId : null,
    activeStreamId: typeof raw.activeStreamId === "string" ? raw.activeStreamId : null,
  };
}

export function resolveImageStudioSize(config: ImageStudioConfig): { width: number; height: number } {
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
    case "1:1":
    default:
      return { width: base.defaultSize.width, height: base.defaultSize.height };
  }
}

export function buildImageGenerationParams(config: ImageStudioConfig): ImageGenerationParams {
  const normalized = normalizeImageStudioConfig(config);
  const size = resolveImageStudioSize(normalized);
  const randomSeed = Math.floor(Math.random() * 2147483647);
  return {
    engine: normalized.engine,
    endpoint: normalized.endpoint,
    width: size.width,
    height: size.height,
    aspectRatio: normalized.aspectRatio,
    steps: normalized.steps,
    guidanceScale: normalized.guidanceScale,
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

export async function checkImageStudioEngineStatus(config: ImageStudioConfig): Promise<ImageStudioEngineStatus> {
  try {
    const result = await checkImageStudioEngine(normalizeImageStudioConfig(config));
    return normalizeImageStudioStatus({
      state: result.ready ? "ready" : "missing",
      message: result.message || (result.ready ? "HiDream HTTP service is reachable." : "Image engine is not reachable."),
      capabilities: {
        ...DEFAULT_CAPABILITIES,
        ...(result.capabilities || {}),
      },
      checkedAt: Date.now(),
    });
  } catch (error) {
    return {
      state: "error",
      message: error instanceof Error ? error.message : String(error || "Image engine check failed."),
      capabilities: DEFAULT_CAPABILITIES,
      checkedAt: Date.now(),
    };
  }
}

export async function startHiDreamGeneration(params: {
  prompt: string;
  config: ImageStudioConfig;
  generationParams: ImageGenerationParams;
  referenceImages?: string[];
}): Promise<{ jobId: string }> {
  const body = {
    mode: "t2i",
    prompt: params.prompt,
    width: params.generationParams.width,
    height: params.generationParams.height,
    seed: params.generationParams.seed,
    refs_b64: (params.referenceImages || []).map(extractBase64Payload).filter(Boolean),
  };
  const response = await proxyImageStudioRequest({
    endpoint: params.config.endpoint,
    path: "/api/generate/start",
    method: "POST",
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(`HiDream start failed with HTTP ${response.status}: ${response.body.slice(0, 240)}`);
  }
  const payload = JSON.parse(response.body || "{}");
  const jobId = String(payload.job_id || payload.jobId || "");
  if (!jobId) throw new Error("HiDream did not return a job id.");
  return { jobId };
}

export async function streamHiDreamGeneration(params: {
  config: ImageStudioConfig;
  jobId: string;
  streamId: string;
  onProgress: (event: ImageGenerationProgress & { previewUrl?: string }) => void;
  onDone: (payload: { imageUrl?: string; error?: string; canceled?: boolean }) => Promise<void> | void;
}): Promise<() => void> {
  let closed = false;
  let deliveredFinalResult = false;
  let sseBuffer = "";
  const cleanupFns: Array<() => void> = [];

  const handleSseEvents = (events: string[]) => {
    for (const event of events) {
      const data = parseJsonObject(event);
      if (!data) continue;
      if (data.type === "progress") {
        const step = clampNumber(data.step, 0, 9999, 0);
        const total = clampNumber(data.total, 0, 9999, 0);
        params.onProgress({
          stage: "generating",
          step,
          total,
          percent: total > 0 ? Math.round((step / total) * 100) : 0,
          message: total > 0 ? `Generating ${step}/${total}` : "Generating",
          ...(typeof data.preview === "string" && data.preview
            ? { previewUrl: `data:image/jpeg;base64,${data.preview}` }
            : {}),
        });
      } else if (data.type === "done") {
        deliveredFinalResult = true;
        void params.onDone({
          imageUrl: typeof data.image === "string" && data.image ? `data:image/png;base64,${data.image}` : undefined,
        });
      } else if (data.type === "error") {
        deliveredFinalResult = true;
        void params.onDone({ error: String(data.message || "Image generation failed.") });
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
      void params.onDone({ error: payload.error || "Image stream failed." });
    } else if (!deliveredFinalResult) {
      void params.onDone({ error: "Image stream ended before a final image was returned." });
    }
  }));

  void proxyImageStudioRequest({
    endpoint: params.config.endpoint,
    path: `/api/generate/stream/${encodeURIComponent(params.jobId)}`,
    method: "GET",
    streamId: params.streamId,
  }).catch((error) => {
    if (!closed) {
      void params.onDone({ error: error instanceof Error ? error.message : String(error || "Image stream failed.") });
    }
  });

  return () => {
    closed = true;
    for (const cleanup of cleanupFns) cleanup();
  };
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
  return saveImageStudioOutput(params.sessionKey, `${Date.now()}-${safeName}.png`, params.imageUrl);
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

function normalizeAspectRatio(value: unknown): ImageStudioAspectRatio {
  return value === "3:4" || value === "4:3" || value === "16:9" || value === "9:16" || value === "1:1"
    ? value
    : "1:1";
}

function extractBase64Payload(dataUrl: string): string {
  const value = String(dataUrl || "").trim();
  const commaIndex = value.indexOf(",");
  if (value.startsWith("data:image/") && commaIndex >= 0) {
    return value.slice(commaIndex + 1).trim();
  }
  return value;
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

function parseJsonObject(value: string): Record<string, any> | null {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed as Record<string, any> : null;
  } catch {
    return null;
  }
}
