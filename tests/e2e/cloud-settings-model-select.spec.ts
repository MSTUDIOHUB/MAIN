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
        ((window as any).__CLOUD_REQUESTS__ ??= []).push({
          url: String(args?.url ?? ""),
          headers: args?.headers ?? null,
        });
        const requestUrl = String(args?.url ?? "");
        const responseModels = requestUrl.includes("second-gateway.example")
          ? ["second-alpha", "second-beta"]
          : seededModels;
        return JSON.stringify({
          data: responseModels.map((id: string) => ({ id })),
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

test("cloud settings starts empty and saves a newly added server explicitly", async ({ page }) => {
  await page.goto("/?e2eScenario=cloud-settings-empty");

  await expect(page.getByRole("heading", { name: "云端接口配置" })).toBeVisible();
  await expect(page.getByTestId("cloud-server-item")).toHaveCount(0);
  await expect(page.getByText("还没有云端服务器")).toBeVisible();
  await expect(page.getByTestId("cloud-model-input")).toHaveCount(0);

  await page.getByTestId("cloud-server-add").click();
  await expect(page.getByTestId("cloud-server-item")).toHaveCount(1);
  await expect(page.getByTestId("cloud-server-item")).toContainText("未保存服务器");
  await expect(page.getByTestId("cloud-server-name-input")).toHaveValue("");
  await expect(page.getByTestId("cloud-server-endpoint-input")).toHaveValue("");
  await expect(page.getByTestId("cloud-server-save")).toBeDisabled();

  await page.getByTestId("cloud-server-name-input").fill("My Gateway");
  await expect(page.getByTestId("cloud-server-name-input")).toHaveValue("My Gateway");
  await expect(page.getByTestId("cloud-server-save")).toBeDisabled();

  await page.getByTestId("cloud-server-endpoint-input").fill("https://my-gateway.example/v1");
  await expect(page.getByTestId("cloud-server-save")).toBeEnabled();
  await page.getByTestId("cloud-server-save").click();
  await expect(page.getByTestId("cloud-server-item")).toContainText("My Gateway");
  await expect(page.getByText("已保存服务器配置")).toBeVisible();
  await expect
    .poll(async () =>
      page.evaluate(() => (window as any).__CODELY_E2E__?.getSnapshot?.().cloudServerCount ?? null),
    )
    .toBe(1);
});

test("cloud status uses the active server model when the compatibility mirror is empty", async ({ page }) => {
  await page.goto("/?e2eScenario=cloud-status-active-server-model");

  const statusButton = page.getByRole("button", { name: /云端 · Qwen3\.6/ });
  await expect(statusButton).toBeVisible();
  await expect(statusButton).toContainText("qwen3.6-coder");
  await expect(statusButton).not.toContainText("未选择模型");

  await statusButton.click();
  await expect(page.getByRole("heading", { name: "云端接口配置" })).toBeVisible();
});

test("cloud settings refreshes models only on request and saves the selected model", async ({ page }) => {
  await page.goto("/?e2eScenario=cloud-settings-model-select");

  const apiFormatSelect = page.locator("select").filter({
    has: page.locator("option[value='responses']"),
  });
  const reasoningEffortSelect = page.locator("select").filter({
    has: page.locator("option[value='xhigh']"),
  });

  await expect(page.getByRole("heading", { name: "云端接口配置" })).toBeVisible();
  await expect(page.getByTestId("cloud-server-item")).toHaveCount(1);
  await expect(page.getByTestId("cloud-server-item")).toContainText("Demo Gateway");
  await expect(apiFormatSelect).toHaveValue("responses");
  await expect(page.getByTestId("cloud-model-input")).toBeVisible();
  await expect(page.getByTestId("cloud-model-select")).toHaveCount(0);
  await expect
    .poll(async () => page.evaluate(() => ((window as any).__CLOUD_REQUESTS__ ?? []).length))
    .toBe(0);

  await page.getByTestId("cloud-model-refresh").click();
  await expect(page.getByTestId("cloud-model-select")).toBeVisible();
  await expect(page.locator("[data-testid='cloud-server-list'] [data-testid='cloud-model-select']")).toHaveCount(0);
  await expect(page.getByTestId("cloud-model-fetched-count")).toContainText("已拉取 12 个模型");
  await expect(page.getByTestId("cloud-model-select")).toHaveValue("gpt-4.1");
  await expect(page.getByTestId("cloud-model-select").locator("option")).toHaveCount(12);
  await expect
    .poll(async () =>
      page.evaluate(() => (window as any).__CODELY_E2E__?.getSnapshot?.().selectedCloudModel ?? null),
    )
    .toBe("gpt-4.1");
  await expect(reasoningEffortSelect).toHaveValue("none");
  await expect(page.getByText("Disable Response Storage")).toBeVisible();

  await page.getByTestId("cloud-model-select").selectOption("qwen-max");
  await expect(page.getByTestId("cloud-model-select")).toHaveValue("qwen-max");
  await expect
    .poll(async () =>
      page.evaluate(() => (window as any).__CODELY_E2E__?.getSnapshot?.().selectedCloudModel ?? null),
    )
    .toBe("qwen-max");
  await expect
    .poll(async () =>
      page.evaluate(() => (window as any).__CODELY_E2E__?.getSnapshot?.().activeCloudServerModel ?? null),
    )
    .toBe("qwen-max");

  await page.getByTestId("cloud-model-mode-toggle").click();
  await expect(page.getByTestId("cloud-model-input")).toBeVisible();

  await page.getByTestId("cloud-model-mode-toggle").click();
  await expect(page.getByTestId("cloud-model-select")).toBeVisible();
  await expect(page.getByTestId("cloud-model-select")).toHaveValue("qwen-max");

  await page.getByTestId("cloud-server-name-input").fill("");
  await expect(page.getByTestId("cloud-server-name-input")).toHaveValue("");
  await page.getByTestId("cloud-server-name-input").fill("Renamed Gateway");
  await expect(page.getByTestId("cloud-server-name-input")).toHaveValue("Renamed Gateway");
  await page.getByTestId("cloud-server-save").click();
  await expect(page.getByTestId("cloud-server-item")).toContainText("Renamed Gateway");
});

test("cloud settings can add, switch, refresh, and delete server configs", async ({ page }) => {
  await page.goto("/?e2eScenario=cloud-settings-model-select");

  await expect(page.getByTestId("cloud-model-input")).toBeVisible();
  await page.getByTestId("cloud-model-refresh").click();
  await expect(page.getByTestId("cloud-model-select")).toHaveValue("gpt-4.1");
  await page.getByTestId("cloud-server-save").click();

  await page.getByTestId("cloud-server-add").click();
  await expect(page.getByTestId("cloud-server-item")).toHaveCount(2);
  await page.getByTestId("cloud-server-name-input").fill("Second Gateway");
  await page.getByTestId("cloud-server-endpoint-input").fill("https://second-gateway.example/v1");
  await page.getByTestId("cloud-server-api-key-input").fill("second-key");
  await page.getByTestId("cloud-model-refresh").click();

  await expect(page.getByTestId("cloud-model-select")).toBeVisible();
  await expect(page.getByTestId("cloud-model-select").locator("option")).toHaveCount(2);
  await expect(page.getByTestId("cloud-model-select")).toHaveValue("second-alpha");
  await expect
    .poll(async () =>
      page.evaluate(() => (window as any).__CODELY_E2E__?.getSnapshot?.().selectedCloudModel ?? null),
    )
    .toBe("second-alpha");
  await expect
    .poll(async () =>
      page.evaluate(() => (window as any).__CODELY_E2E__?.getSnapshot?.().activeCloudServerModel ?? null),
    )
    .toBe("second-alpha");

  const requests = await page.evaluate(() => (window as any).__CLOUD_REQUESTS__ ?? []);
  expect(requests.some((request: { url: string }) => request.url.includes("second-gateway.example/v1/models"))).toBeTruthy();

  await page.getByTestId("cloud-server-item").filter({ hasText: "Demo Gateway" }).click();
  await expect(page.getByTestId("cloud-model-select")).toHaveValue("gpt-4.1");

  const secondServer = page.getByTestId("cloud-server-item").filter({ hasText: "Second Gateway" });
  await secondServer.click();
  await expect(page.getByTestId("cloud-model-select")).toHaveValue("second-alpha");
  await secondServer.locator("span[title='删除服务器']").click();

  await expect(page.getByTestId("cloud-server-item")).toHaveCount(1);
  await expect(page.getByTestId("cloud-server-item")).toContainText("Demo Gateway");
  await expect
    .poll(async () =>
      page.evaluate(() => (window as any).__CODELY_E2E__?.getSnapshot?.().cloudServerCount ?? null),
    )
    .toBe(1);
});
