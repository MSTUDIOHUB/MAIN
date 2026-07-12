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

try {
  const response = await fetch(`${endpoint}/models`, {
    headers: authHeaders,
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
} catch (error) {
  console.error(`[real-omlx-plan] 验收未完成：OMLX 不可用（${endpoint}）。${error instanceof Error ? error.message : String(error)}`);
  process.exit(2);
}

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
    },
  },
);

if (result.error) {
  console.error(`[real-omlx-plan] 验收未完成：${result.error.message}`);
  process.exit(2);
}
process.exit(result.status ?? 1);
