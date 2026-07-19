import { spawnSync } from "node:child_process";
import path from "node:path";

const endpoint = String(
  process.env.OMLX_ENDPOINT || process.env.OMLX_BASE_URL || "http://127.0.0.1:8000/v1",
).replace(/\/+$/, "");
const apiKey = String(process.env.OMLX_API_KEY || "mmnn");
const authHeaders = apiKey
  ? {
      authorization: `Bearer ${apiKey}`,
      "x-api-key": apiKey,
    }
  : {};

let loadedModelIds = [];
try {
  const statusResponse = await fetch(`${endpoint}/models/status`, {
    headers: authHeaders,
    signal: AbortSignal.timeout(5_000),
  });
  if (!statusResponse.ok) throw new Error(`status HTTP ${statusResponse.status}`);
  const status = await statusResponse.json();
  loadedModelIds = Array.isArray(status?.models)
    ? status.models
        .filter((model) => model?.loaded === true && model?.is_loading !== true)
        .map((model) => String(model?.id || "").trim())
        .filter(Boolean)
    : [];
  if (loadedModelIds.length === 0) {
    throw new Error("no fully loaded model; refusing to trigger an implicit large-model load");
  }

  const modelsResponse = await fetch(`${endpoint}/models`, {
    headers: authHeaders,
    signal: AbortSignal.timeout(5_000),
  });
  if (!modelsResponse.ok) throw new Error(`models HTTP ${modelsResponse.status}`);
} catch (error) {
  console.error(`[real-omlx-plan] 验收未完成：OMLX 不可用（${endpoint}）。${error instanceof Error ? error.message : String(error)}`);
  process.exit(2);
}

const requestedModelIds = String(process.env.OMLX_MODELS || "")
  .split(",")
  .map((model) => model.trim())
  .filter(Boolean);
const selectedModelIds = requestedModelIds.length > 0 ? requestedModelIds : [loadedModelIds[0]];
const unloadedRequestedModels = selectedModelIds.filter((model) => !loadedModelIds.includes(model));
if (unloadedRequestedModels.length > 0) {
  console.error(
    `[real-omlx-plan] 验收未完成：请求的模型尚未加载（${unloadedRequestedModels.join(", ")}）。` +
    `当前已加载：${loadedModelIds.join(", ")}。为避免隐式加载第二个大模型，本脚本不会继续。`,
  );
  process.exit(2);
}
console.log(`[real-omlx-plan] 使用已加载模型：${selectedModelIds.join(", ")}（加载状态未改变）`);

const cli = path.resolve("node_modules/@playwright/test/cli.js");
const result = spawnSync(
  process.execPath,
  [cli, "test", "tests/e2e/real-omlx-plan-flow.spec.ts", "--grep", "plan/approve/execute"],
  {
    stdio: "inherit",
    env: {
      ...process.env,
      MAIN_REAL_OMLX_E2E: "1",
      PLAYWRIGHT_REUSE_EXISTING_SERVER: "0",
      OMLX_ENDPOINT: endpoint,
      OMLX_API_KEY: apiKey,
      OMLX_MODELS: selectedModelIds.join(","),
    },
  },
);

if (result.error) {
  console.error(`[real-omlx-plan] 验收未完成：${result.error.message}`);
  process.exit(2);
}
process.exit(result.status ?? 1);
