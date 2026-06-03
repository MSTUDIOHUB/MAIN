import test from "node:test";
import assert from "node:assert/strict";
import fsSync from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import ts from "typescript";

const require = createRequire(import.meta.url);
const workspaceRoot = process.cwd();

const transpiledModuleCache = new Map();

function loadTranspiledModuleSync(sourcePath) {
  const normalizedPath = path.resolve(sourcePath);
  if (transpiledModuleCache.has(normalizedPath)) {
    return transpiledModuleCache.get(normalizedPath);
  }

  const source = fsSync.readFileSync(normalizedPath, "utf8");
  const localRequire = createRequire(normalizedPath);
  const transpiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
    },
    fileName: normalizedPath,
  }).outputText;

  const module = { exports: {} };
  transpiledModuleCache.set(normalizedPath, module.exports);

  const runtimeRequire = (specifier) => {
    if (specifier.startsWith(".")) {
      const basePath = path.resolve(path.dirname(normalizedPath), specifier);
      const candidates = [
        basePath,
        `${basePath}.ts`,
        `${basePath}.tsx`,
        path.join(basePath, "index.ts"),
      ];

      for (const candidate of candidates) {
        if (!fsSync.existsSync(candidate)) continue;
        if (candidate.endsWith(".ts") || candidate.endsWith(".tsx")) {
          return loadTranspiledModuleSync(candidate);
        }
      }
    }

    return localRequire(specifier);
  };

  const factory = new Function("exports", "module", "require", transpiled);
  factory(module.exports, module, runtimeRequire);
  transpiledModuleCache.set(normalizedPath, module.exports);
  return module.exports;
}

const {
  IMAGE_STUDIO_LOCAL_DEFAULT_ENDPOINT,
  getDefaultImageStudioEndpointForServiceFamily,
  mapLocalModelProviderToImageStudioServiceFamily,
  normalizeImageStudioConfig,
  normalizeImageStudioRuntime,
  buildImageGenerationParams,
} = loadTranspiledModuleSync(path.join(workspaceRoot, "src/lib/imageStudio.ts"));

test("legacy hosted image studio config migrates to web_fallback", () => {
  const config = normalizeImageStudioConfig({
    engine: "huggingface_space",
    endpoint: "https://hidream-ai-hidream-o1-image-dev.hf.space",
    promptRefine: false,
    aspectRatio: "16:9",
  });

  assert.equal(config.provider, "web_fallback");
  assert.equal(config.web.endpoint, "https://hidream-ai-hidream-o1-image-dev.hf.space");
  assert.equal(config.web.promptRefine, false);
  assert.equal(config.local.endpoint, IMAGE_STUDIO_LOCAL_DEFAULT_ENDPOINT);
  assert.equal(config.aspectRatio, "16:9");
});

test("legacy local image config migrates to local_image_service", () => {
  const config = normalizeImageStudioConfig({
    engine: "hidream_http",
    endpoint: "http://127.0.0.1:8000/v1",
    model: "Qwen-Image",
    steps: 22,
  });

  assert.equal(config.provider, "local_image_service");
  assert.equal(config.local.endpoint, "http://127.0.0.1:8000/v1");
  assert.equal(config.local.model, "Qwen-Image");
  assert.equal(config.steps, 22);
});

test("disabled web fallback cannot remain the active provider", () => {
  const config = normalizeImageStudioConfig({
    provider: "web_fallback",
    web: {
      endpoint: "https://hidream-ai-hidream-o1-image-dev.hf.space",
      enabled: false,
    },
  });

  assert.equal(config.provider, "local_image_service");
  assert.equal(config.web.enabled, false);
});

test("runtime normalization keeps provider-aware status metadata", () => {
  const runtime = normalizeImageStudioRuntime({
    config: {
      provider: "local_image_service",
      local: {
        endpoint: "http://127.0.0.1:8001/v1",
        model: "Qwen-Image",
        protocol: "openai_images",
      },
    },
    status: {
      providerKind: "local_image_service",
      state: "ready",
      message: "ok",
      discoveredModels: ["Qwen-Image", "flux-dev"],
      activeModel: "Qwen-Image",
    },
  });

  assert.equal(runtime.config.provider, "local_image_service");
  assert.deepEqual(runtime.status.discoveredModels, ["Qwen-Image", "flux-dev"]);
  assert.equal(runtime.status.activeModel, "Qwen-Image");
});

test("local image params include model and protocol", () => {
  const params = buildImageGenerationParams(normalizeImageStudioConfig({
    provider: "local_image_service",
    local: {
      endpoint: "http://127.0.0.1:8000/v1",
      model: "Qwen-Image",
      protocol: "openai_images",
    },
    aspectRatio: "3:4",
    steps: 30,
    guidanceScale: 4,
    seedMode: "fixed",
    seed: 42,
  }));

  assert.equal(params.providerKind, "local_image_service");
  assert.equal(params.model, "Qwen-Image");
  assert.equal(params.protocol, "openai_images");
  assert.equal(params.width, 896);
  assert.equal(params.height, 1152);
  assert.equal(params.seed, 42);
});

test("image studio local settings map MAIN local providers to matching families", () => {
  assert.equal(mapLocalModelProviderToImageStudioServiceFamily("OMLX"), "omlx");
  assert.equal(mapLocalModelProviderToImageStudioServiceFamily("Ollama"), "ollama");
  assert.equal(mapLocalModelProviderToImageStudioServiceFamily("LM Studio"), "openai_compatible");
  assert.equal(getDefaultImageStudioEndpointForServiceFamily("omlx"), IMAGE_STUDIO_LOCAL_DEFAULT_ENDPOINT);
  assert.equal(getDefaultImageStudioEndpointForServiceFamily("ollama"), "http://127.0.0.1:11434/v1");
});
