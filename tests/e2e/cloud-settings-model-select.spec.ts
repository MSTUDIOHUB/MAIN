import { expect, test } from "@playwright/test";

const models = [
  "gpt-4.1",
  "gpt-4.1-mini",
  "gpt-4o",
  "gpt-4o-mini",
  "o4-mini",
  "claude-sonnet-4-5",
  "claude-3-7-sonnet",
  "qwen-max",
  "qwen-plus",
  "deepseek-chat",
  "deepseek-reasoner",
  "gemini-2.5-pro",
];

test.beforeEach(async ({ page }) => {
  await page.addInitScript(({ seededModels }) => {
    if (!window.sessionStorage.getItem("__CODELY_E2E_STORAGE_RESET__")) {
      window.localStorage.clear();
      window.sessionStorage.setItem("__CODELY_E2E_STORAGE_RESET__", "1");
    }

    const internals = ((window as any).__TAURI_INTERNALS__ ??= {});
    internals.transformCallback ??= () => 1;
    internals.unregisterCallback ??= () => {};
    internals.metadata ??= {
      currentWindow: { label: "main" },
      currentWebview: { label: "main" },
    };
    internals.invoke = async (cmd: string, args?: Record<string, unknown>) => {
      if (cmd === "get_system_memory") {
        return { total_gb: 32, available_gb: 24 };
      }
      if (cmd === "proxy_request") {
        return JSON.stringify({
          data: seededModels.map((id: string) => ({ id })),
        });
      }
      if (cmd === "set_workspace_root") {
        return String(args?.path ?? "");
      }
      if (cmd === "get_workspace_root") {
        return "";
      }
      return null;
    };
  }, { seededModels: models });
});

test("cloud settings auto-fetches models and renders a selectable dropdown", async ({ page }) => {
  await page.goto("/?e2eScenario=cloud-settings-model-select");

  const apiFormatSelect = page.locator("select").filter({
    has: page.locator("option[value='responses']"),
  });
  const reasoningEffortSelect = page.locator("select").filter({
    has: page.locator("option[value='xhigh']"),
  });

  await expect(page.getByRole("heading", { name: "云端接口配置" })).toBeVisible();
  await expect(apiFormatSelect).toHaveValue("responses");
  await expect(page.getByTestId("cloud-model-select")).toBeVisible();
  await expect(page.getByTestId("cloud-model-fetched-count")).toContainText("已拉取 12 个模型");
  await expect(page.getByTestId("cloud-model-select")).toHaveValue("gpt-4.1");
  await expect(page.getByTestId("cloud-model-select").locator("option")).toHaveCount(12);
  await expect(reasoningEffortSelect).toHaveValue("xhigh");
  await expect(page.getByText("Disable Response Storage")).toBeVisible();

  await page.getByTestId("cloud-model-select").selectOption("qwen-max");
  await expect(page.getByTestId("cloud-model-select")).toHaveValue("qwen-max");
  await expect
    .poll(async () =>
      page.evaluate(() => (window as any).__CODELY_E2E__?.getSnapshot?.().selectedCloudModel ?? null),
    )
    .toBe("qwen-max");

  await page.getByTestId("cloud-model-mode-toggle").click();
  await expect(page.getByTestId("cloud-model-input")).toBeVisible();

  await page.getByTestId("cloud-model-mode-toggle").click();
  await expect(page.getByTestId("cloud-model-select")).toBeVisible();
  await expect(page.getByTestId("cloud-model-select")).toHaveValue("qwen-max");
});
