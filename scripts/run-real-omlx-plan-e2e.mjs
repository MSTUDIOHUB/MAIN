import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
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

async function readSingleModelStatus(expectedModelId, phase) {
  const statusResponse = await fetch(`${endpoint}/models/status`, {
    headers: authHeaders,
    signal: AbortSignal.timeout(5_000),
  });
  if (!statusResponse.ok) throw new Error(`status HTTP ${statusResponse.status}`);
  const status = await statusResponse.json();
  const statusModels = Array.isArray(status?.models) ? status.models : [];
  const loadedModelIds = statusModels
    .filter((model) => model?.loaded === true && model?.is_loading !== true)
    .map((model) => String(model?.id || "").trim())
    .filter(Boolean);
  const transitioningModelIds = statusModels
    .filter((model) => model?.is_loading === true)
    .map((model) => String(model?.id || "").trim())
    .filter(Boolean);
  if (loadedModelIds.length === 0) {
    throw new Error("no fully loaded model; refusing to trigger an implicit large-model load");
  }
  if (
    loadedModelIds.length !== 1 ||
    Number(status?.loaded_count) !== 1 ||
    transitioningModelIds.length > 0
  ) {
    throw new Error(
      `single-model safety gate failed (loaded=${loadedModelIds.join(",") || "none"}; ` +
      `transitioning=${transitioningModelIds.join(",") || "none"}); refusing to validate with overlapping model memory`,
    );
  }
  if (expectedModelId && loadedModelIds[0] !== expectedModelId) {
    throw new Error(
      `${phase} model identity changed (expected=${expectedModelId}; loaded=${loadedModelIds[0] || "none"})`,
    );
  }
  return { loadedModelIds, transitioningModelIds };
}

async function readSingleModelStatusWithRetry(expectedModelId, phase) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      return await readSingleModelStatus(expectedModelId, phase);
    } catch (error) {
      lastError = error;
      if (attempt < 3) {
        await new Promise((resolve) => setTimeout(resolve, 1_000));
      }
    }
  }
  throw lastError;
}

let initialStatus;
try {
  initialStatus = await readSingleModelStatusWithRetry(undefined, "preflight");

  const modelsResponse = await fetch(`${endpoint}/models`, {
    headers: authHeaders,
    signal: AbortSignal.timeout(5_000),
  });
  if (!modelsResponse.ok) throw new Error(`models HTTP ${modelsResponse.status}`);
} catch (error) {
  console.error(`[real-omlx-plan] 验收未完成：OMLX 不可用（${endpoint}）。${error instanceof Error ? error.message : String(error)}`);
  process.exit(2);
}

const loadedModelIds = initialStatus.loadedModelIds;

const requestedModelIds = String(process.env.OMLX_MODELS || "")
  .split(",")
  .map((model) => model.trim())
  .filter(Boolean);
const selectedModelIds = requestedModelIds.length > 0 ? requestedModelIds : [loadedModelIds[0]];
if (selectedModelIds.length !== 1) {
  console.error(
    `[real-omlx-plan] 验收未完成：一次只能指定一个模型（收到 ${selectedModelIds.length} 个）。` +
    "请先完全卸载当前模型、确认 loaded_count=0，再加载下一个模型。",
  );
  process.exit(2);
}
const unloadedRequestedModels = selectedModelIds.filter((model) => !loadedModelIds.includes(model));
if (unloadedRequestedModels.length > 0) {
  console.error(
    `[real-omlx-plan] 验收未完成：请求的模型尚未加载（${unloadedRequestedModels.join(", ")}）。` +
    `当前已加载：${loadedModelIds.join(", ")}。为避免隐式加载第二个大模型，本脚本不会继续。`,
  );
  process.exit(2);
}
try {
  await readSingleModelStatusWithRetry(selectedModelIds[0], "preflight");
} catch (error) {
  console.error(
    `[real-omlx-plan] 验收未完成：启动 Playwright 前模型状态发生变化。${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(2);
}

const preparedWorkspace = String(process.env.REAL_OMLX_WORKSPACE || "").trim();
const testGrep = String(
  process.env.REAL_OMLX_TEST_GREP || "plan/approve/execute",
).trim();
if (!testGrep) {
  console.error("[real-omlx-plan] 验收未完成：REAL_OMLX_TEST_GREP 不能为空。");
  process.exit(2);
}
if (preparedWorkspace) {
  try {
    const workspaceStat = await fs.stat(preparedWorkspace);
    if (!workspaceStat.isDirectory()) throw new Error("path is not a directory");
    const workspaceEntries = await fs.readdir(preparedWorkspace);
    if (workspaceEntries.length === 0) {
      throw new Error("directory is empty");
    }
  } catch (error) {
    console.error(
      `[real-omlx-plan] 验收未完成：REAL_OMLX_WORKSPACE 必须是调用方预先复制好的非空工作区（${preparedWorkspace}）。` +
      `${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(2);
  }
}
console.log(`[real-omlx-plan] 使用已加载模型：${selectedModelIds.join(", ")}（加载状态未改变）`);
const requireTaskQuality =
  process.env.REAL_OMLX_REQUIRE_TASK_QUALITY === "1" ||
  (
    process.env.REAL_OMLX_EXECUTE_INCIDENT === "1" &&
    process.env.REAL_OMLX_FIXTURE === "md-viewer"
  );
console.log(
  requireTaskQuality
    ? "[real-omlx-plan] 验收模式：Runtime v2 结构一致性 + 强制任务语义质量门禁"
    : "[real-omlx-plan] 验收模式：Runtime v2 结构一致性（任务语义质量仅记录，不决定成败）",
);

const cli = path.resolve("node_modules/@playwright/test/cli.js");
const result = spawnSync(
  process.execPath,
  [cli, "test", "tests/e2e/real-omlx-plan-flow.spec.ts", "--grep", testGrep],
  {
    stdio: "inherit",
    env: {
      ...process.env,
      MAIN_REAL_OMLX_E2E: "1",
      PLAYWRIGHT_REUSE_EXISTING_SERVER: "0",
      OMLX_ENDPOINT: endpoint,
      OMLX_API_KEY: apiKey,
      OMLX_MODELS: selectedModelIds.join(","),
      ...(requireTaskQuality
        ? { REAL_OMLX_REQUIRE_TASK_QUALITY: "1" }
        : {}),
    },
  },
);

try {
  await readSingleModelStatusWithRetry(selectedModelIds[0], "postflight");
  console.log(`[real-omlx-plan] 验收后模型状态未改变：${selectedModelIds[0]} 仍是唯一已加载模型`);
} catch (error) {
  console.error(
    `[real-omlx-plan] 验收未完成：验收后单模型安全检查失败。${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(2);
}

if (result.error) {
  console.error(`[real-omlx-plan] 验收未完成：${result.error.message}`);
  process.exit(2);
}
process.exit(result.status ?? 1);
