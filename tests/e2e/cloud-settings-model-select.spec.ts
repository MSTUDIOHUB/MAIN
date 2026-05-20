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
      if (cmd === "cloud_auth_begin") {
        ((window as any).__CLOUD_AUTH_COMMANDS__ ??= []).push({ cmd, args });
        return {
          sessionId: "mock-cloud-auth-session",
          provider: args?.provider,
          mode: args?.mode,
          authUrl: "https://auth.example/mock",
          redirectUri: "http://127.0.0.1:1455/auth/callback",
          expiresAt: Date.now() + 300000,
          browserOpened: true,
        };
      }
      if (cmd === "cloud_auth_finish") {
        ((window as any).__CLOUD_AUTH_COMMANDS__ ??= []).push({ cmd, args });
        const mode = ((window as any).__CLOUD_AUTH_MODE__ ?? "openai_chatgpt_oauth") as string;
        return {
          mode,
          status: "connected",
          tokenRef: String(args?.serverId ?? "mock-server"),
          accountId: mode === "openai_chatgpt_oauth" ? "chatgpt-account" : "google-account",
          email: mode === "openai_chatgpt_oauth" ? "openai@example.com" : "gemini@example.com",
          expiresAt: Date.now() + 3600000,
          storage: "file",
          message: "Stored in app data with 0600 file permissions.",
          projectId: mode === "gemini_google_oauth" ? "mock-code-assist-project" : undefined,
          tier: mode === "gemini_google_oauth" ? "free-tier" : undefined,
          onboarded: mode === "gemini_google_oauth" ? true : undefined,
          codeAssistMessage: mode === "gemini_google_oauth" ? "Gemini Code Assist project loaded." : undefined,
        };
      }
      if (cmd === "cloud_auth_logout") {
        ((window as any).__CLOUD_AUTH_COMMANDS__ ??= []).push({ cmd, args });
        return { mode: "api_key", status: "disconnected" };
      }
      if (cmd === "proxy_request") {
        ((window as any).__CLOUD_REQUESTS__ ??= []).push({
          url: String(args?.url ?? ""),
          method: String(args?.method ?? ""),
          headers: args?.headers ?? null,
          body: args?.body ? JSON.parse(String(args.body)) : null,
        });
        const requestUrl = String(args?.url ?? "");
        const method = String(args?.method ?? "GET").toUpperCase();
        if (method === "POST") {
          const body = args?.body ? JSON.parse(String(args.body)) : {};
          const behavior = (window as any).__CLOUD_TEST_BEHAVIOR__ ?? "success";
          if (behavior === "openai-probe-first-fails" && requestUrl.includes("/responses")) {
            if (body.model === "gpt-5.5") {
              throw new Error("HTTP 401: invalid_token");
            }
          }
          if (behavior === "openai-oauth-instructions-required" && requestUrl.includes("/responses")) {
            throw new Error("HTTP 400: {\"detail\":\"Instructions are required\"}");
          }
          if (behavior === "gemini-oauth-scope-insufficient" && requestUrl.includes("v1internal:generateContent")) {
            throw new Error("HTTP 403: {\"error\":{\"code\":403,\"message\":\"Request had insufficient authentication scopes.\",\"status\":\"PERMISSION_DENIED\",\"details\":[{\"reason\":\"ACCESS_TOKEN_SCOPE_INSUFFICIENT\"}]}}");
          }
          if (behavior === "responses-fail-chat-succeeds" && requestUrl.includes("/responses")) {
            throw new Error("HTTP 400: unsupported Responses API");
          }
          if (behavior === "advanced-fails" && (body.store === false || body.reasoning)) {
            throw new Error("HTTP 400: unsupported parameter: store");
          }
          if (requestUrl.includes("/responses")) {
            return "__CONTENT_TYPE__:text/event-stream\n"
              + "event: response.output_text.delta\n"
              + "data: {\"delta\":\"ok\"}\n\n"
              + "event: response.completed\n"
              + "data: {}\n\n";
          }
          if (requestUrl.includes("v1internal:generateContent")) {
            return JSON.stringify({ response: { candidates: [{ content: { parts: [{ text: "ok" }] } }] } });
          }
          if (requestUrl.includes(":generateContent")) {
            return JSON.stringify({ candidates: [{ content: { parts: [{ text: "ok" }] } }] });
          }
          return JSON.stringify({
            choices: [
              {
                message: { content: "ok" },
                finish_reason: "stop",
              },
            ],
          });
        }
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

async function enableCloudLab(page: import("@playwright/test").Page) {
  await page.getByTestId("cloud-lab-toggle").click();
  await expect(page.getByTestId("cloud-lab-toggle")).toHaveAttribute("aria-checked", "true");
}

test("cloud settings hides sampling params and keeps advanced compatibility collapsed", async ({ page }) => {
  await page.goto("/?e2eScenario=cloud-settings-model-select");

  await expect(page.getByTestId("cloud-lab-toggle")).toHaveAttribute("aria-checked", "false");
  await expect(page.getByTestId("cloud-auth-mode-api_key")).toBeVisible();
  await expect(page.getByTestId("cloud-auth-mode-openai_chatgpt_oauth")).toHaveCount(0);
  await expect(page.getByTestId("cloud-auth-mode-gemini_google_oauth")).toHaveCount(0);
  await expect(page.getByText("ChatGPT Pro/Plus/Codex 实验登录")).toHaveCount(0);
  await expect(page.getByText("Gemini Google 实验登录")).toHaveCount(0);
  await expect(page.getByText("Temperature")).toHaveCount(0);
  await expect(page.getByText("Top P")).toHaveCount(0);
  await expect(page.getByTestId("cloud-advanced-compatibility")).not.toHaveAttribute("open", "");
  await expect(page.getByTestId("cloud-server-endpoint-input")).toBeVisible();
  await expect(page.getByText("高级兼容性")).toHaveCount(0);
  await expect(page.getByText("详细设置")).toBeVisible();
  await expect(page.getByText("推荐优先让用户直接在这里填写协议")).toHaveCount(0);

  await page.getByText("详细设置").click();
  await expect(page.getByText("Reasoning Effort")).toBeVisible();
  await expect(page.getByText("Disable Response Storage")).toBeVisible();
  await expect(page.getByText("Additional Headers (JSON)")).toBeVisible();
});

test("local settings exposes tool protocol and resets endpoint/model/protocol on provider switch", async ({ page }) => {
  await page.goto("/?e2eScenario=cloud-settings-model-select");

  await page.getByTestId("settings-tab-local").click();
  await expect(page.getByTestId("local-model-select")).toBeVisible();
  await expect(page.getByTestId("local-model-select")).not.toHaveValue("");
  await expect(page.getByTestId("local-advanced-compatibility")).not.toHaveAttribute("open", "");
  await page.getByTestId("local-advanced-compatibility").locator("summary").click();
  await expect(page.getByTestId("local-tool-protocol-select")).toHaveValue("auto");

  await page.getByTestId("local-provider-select").selectOption("LM Studio");
  await expect(page.getByTestId("local-endpoint-input")).toHaveValue("http://127.0.0.1:1234/v1");
  await expect(page.getByTestId("local-tool-protocol-select")).toHaveValue("xml");
  await expect(page.getByTestId("local-model-select")).toHaveValue("");

  await page.getByTestId("local-provider-select").selectOption("OMLX");
  await expect(page.getByTestId("local-endpoint-input")).toHaveValue("http://127.0.0.1:8000/v1");
  await expect(page.getByTestId("local-tool-protocol-select")).toHaveValue("auto");
  await expect(page.getByTestId("local-model-select")).toHaveValue("");

  await page.getByTestId("local-provider-select").selectOption("Ollama");
  await expect(page.getByTestId("local-endpoint-input")).toHaveValue("http://127.0.0.1:11434/v1");
  await expect(page.getByTestId("local-tool-protocol-select")).toHaveValue("xml");
  await expect(page.getByTestId("local-model-select")).toHaveValue("");
});

test("model runtime lock disables current model switching while allowing non-running cloud config edits", async ({ page }) => {
  await page.goto("/?e2eScenario=cloud-settings-model-select");

  await page.evaluate(() => {
    (window as any).__CODELY_E2E__?.setCloudServers?.([
      {
        id: "demo-openai",
        name: "Demo Gateway",
        protocol: "openai",
        provider: "OpenAI",
        apiFormat: "responses",
        endpoint: "https://demo-gateway.example/v1",
        apiKey: "demo-key",
        model: "gpt-active",
        customHeaders: "",
        reasoningEffort: "none",
        disableResponseStorage: true,
        toolProtocol: "auto",
        auth: { mode: "api_key", status: "disconnected" },
      },
      {
        id: "backup-openai",
        name: "Backup Gateway",
        protocol: "openai",
        provider: "OpenAI",
        apiFormat: "responses",
        endpoint: "https://second-gateway.example/v1",
        apiKey: "backup-key",
        model: "second-alpha",
        customHeaders: "",
        reasoningEffort: "none",
        disableResponseStorage: true,
        toolProtocol: "auto",
        auth: { mode: "api_key", status: "disconnected" },
      },
    ], "demo-openai");
    (window as any).__CODELY_E2E__?.setModelRuntimeLock?.({
      activeProfile: "cloud",
      activeCloudServerId: "demo-openai",
      status: "running",
    });
  });

  await expect(page.getByTestId("model-runtime-lock-notice")).toBeVisible();
  await expect(page.getByTestId("cloud-active-profile-button")).toBeDisabled();
  await expect(page.getByTestId("cloud-lab-toggle")).toBeDisabled();
  await expect(page.getByTestId("cloud-model-input")).toBeDisabled();
  await expect(page.getByTestId("cloud-model-refresh")).toBeDisabled();
  await expect(page.getByTestId("cloud-model-test")).toBeDisabled();
  await expect(page.getByTestId("cloud-server-name-input")).toBeDisabled();

  await page.getByTestId("settings-tab-local").click();
  await expect(page.getByTestId("local-active-profile-button")).toBeDisabled();
  await expect(page.getByTestId("local-provider-select")).toBeDisabled();
  await expect(page.getByTestId("local-endpoint-input")).toBeDisabled();
  await expect(page.getByTestId("local-model-select")).toBeDisabled();

  await page.getByTestId("settings-tab-cloud").click();
  await page.getByTestId("cloud-server-item").filter({ hasText: "Backup Gateway" }).click();
  await expect(page.getByTestId("cloud-server-name-input")).toBeEnabled();
  await expect(page.getByTestId("cloud-server-endpoint-input")).toBeEnabled();
  await expect(page.getByTestId("cloud-model-input")).toBeEnabled();

  await page.getByTestId("cloud-server-name-input").fill("Backup Edited");
  await page.getByTestId("cloud-server-save").click();
  await expect(page.getByText("已保存服务器配置")).toBeVisible();
  await expect(page.getByTestId("cloud-server-item").filter({ hasText: "Backup Edited" })).toHaveCount(1);
  await expect
    .poll(async () => page.evaluate(() => (window as any).__CODELY_E2E__?.getSnapshot?.().activeCloudServerId ?? null))
    .toBe("demo-openai");
  await expect
    .poll(async () => page.evaluate(() => (window as any).__CODELY_E2E__?.getSnapshot?.().activeCloudServerModel ?? null))
    .toBe("gpt-active");
});

test("OpenAI experimental login shows status and refreshes Codex model candidates", async ({ page }) => {
  await page.goto("/?e2eScenario=cloud-settings-model-select");
  await page.evaluate(() => {
    (window as any).__CLOUD_AUTH_MODE__ = "openai_chatgpt_oauth";
  });

  await enableCloudLab(page);
  await page.getByTestId("cloud-auth-mode-openai_chatgpt_oauth").click();
  await page.getByText("详细设置").click();
  await expect(page.getByTestId("cloud-api-format-select")).toHaveValue("responses");
  await expect(page.getByTestId("cloud-api-format-select")).toBeDisabled();
  await expect(page.getByText("OpenAI 实验登录固定使用 Responses API。")).toBeVisible();
  await expect(page.getByText("ChatGPT Pro/Plus/Codex 实验登录")).toBeVisible();
  await expect(page.getByText("不承诺免费账号可用")).toBeVisible();
  await page.getByTestId("cloud-auth-login").click();
  await expect(page.getByText(/已登录 · openai@example\.com/)).toBeVisible();

  await page.getByTestId("cloud-model-refresh").click();
  await expect(page.getByTestId("cloud-model-select")).toBeVisible();
  await expect(page.getByTestId("cloud-model-select")).toHaveValue("gpt-5.5");
  await expect(page.getByTestId("cloud-model-select").locator("option", { hasText: /^gpt-5\.4$/ })).toHaveCount(1);

  const commands = await page.evaluate(() => (window as any).__CLOUD_AUTH_COMMANDS__ ?? []);
  expect(commands.some((call: any) => call.cmd === "cloud_auth_begin" && call.args.mode === "openai_chatgpt_oauth")).toBeTruthy();
});

test("OpenAI experimental login refresh prefers cached probe-success model on subsequent refreshes", async ({ page }) => {
  await page.goto("/?e2eScenario=cloud-settings-model-select");
  await page.evaluate(() => {
    (window as any).__CLOUD_AUTH_MODE__ = "openai_chatgpt_oauth";
    (window as any).__CLOUD_TEST_BEHAVIOR__ = "openai-probe-first-fails";
  });

  await enableCloudLab(page);
  await page.getByTestId("cloud-auth-mode-openai_chatgpt_oauth").click();
  await page.getByTestId("cloud-auth-login").click();
  await expect(page.getByText(/已登录 · openai@example\.com/)).toBeVisible();

  await page.getByTestId("cloud-model-refresh").click();
  await expect(page.getByTestId("cloud-model-select")).toHaveValue("gpt-5.4");

  const firstRefreshRequests = await page.evaluate(() =>
    ((window as any).__CLOUD_REQUESTS__ ?? []).filter((request: any) => request.method === "POST" && request.url.includes("/responses")),
  );
  expect(firstRefreshRequests[0]?.body?.model).toBe("gpt-5.5");
  expect(firstRefreshRequests.some((request: any) => request.body?.model === "gpt-5.4")).toBeTruthy();

  await page.evaluate(() => { (window as any).__CLOUD_REQUESTS__ = []; });
  await page.getByTestId("cloud-model-refresh").click();
  await expect(page.getByTestId("cloud-model-select")).toHaveValue("gpt-5.4");

  const secondRefreshRequests = await page.evaluate(() =>
    ((window as any).__CLOUD_REQUESTS__ ?? []).filter((request: any) => request.method === "POST" && request.url.includes("/responses")),
  );
  expect(secondRefreshRequests[0]?.body?.model).toBe("gpt-5.4");
});

test("OpenAI experimental login probes with Codex-compatible input text", async ({ page }) => {
  await page.goto("/?e2eScenario=cloud-settings-model-select");
  await page.evaluate(() => {
    (window as any).__CLOUD_AUTH_MODE__ = "openai_chatgpt_oauth";
  });

  await enableCloudLab(page);
  await page.getByTestId("cloud-auth-mode-openai_chatgpt_oauth").click();
  await page.getByTestId("cloud-auth-login").click();
  await expect(page.getByText(/已登录 · openai@example\.com/)).toBeVisible();
  await page.getByTestId("cloud-model-refresh").click();
  await page.getByTestId("cloud-model-test").click();

  const requests = await page.evaluate(() => (window as any).__CLOUD_REQUESTS__ ?? []);
  const probe = requests.find((request: any) => request.method === "POST" && request.url.includes("/responses"));
  expect(probe?.body?.model).toBe("gpt-5.5");
  expect(probe?.body?.input?.[0]?.content?.[0]?.type).toBe("input_text");
  expect(probe?.body?.user_prompt_id).toBe("main-cloud-test");
  expect(probe?.body?.instructions).toBeTruthy();
  expect(probe?.body?.store).toBe(false);
  expect(probe?.body?.stream).toBe(true);
  expect(probe?.body?.temperature).toBeUndefined();
  expect(probe?.body?.top_p).toBeUndefined();
});

test("Gemini Google login shows Cloud Project hint and native model candidates", async ({ page }) => {
  await page.goto("/?e2eScenario=cloud-settings-model-select");
  await page.evaluate(() => {
    (window as any).__CLOUD_AUTH_MODE__ = "gemini_google_oauth";
  });

  await enableCloudLab(page);
  await page.getByTestId("cloud-auth-mode-gemini_google_oauth").click();
  await expect(page.getByText("Gemini Google 实验登录")).toBeVisible();
  await expect(page.getByText(/GOOGLE_CLOUD_PROJECT/)).toBeVisible();
  await page.getByTestId("cloud-auth-login").click();
  await expect(page.getByText(/已登录 · gemini@example\.com/)).toBeVisible();
  await expect(page.getByText(/Project: mock-code-assist-project/)).toBeVisible();

  await page.getByTestId("cloud-model-refresh").click();
  await expect(page.getByTestId("cloud-model-select")).toBeVisible();
  await expect(page.getByTestId("cloud-model-select").locator("option").filter({ hasText: "gemini-2.5-pro" })).toHaveCount(1);
});

test("OAuth cloud test maps OpenAI instructions-required and Gemini scope errors to actionable hints", async ({ page }) => {
  await page.goto("/?e2eScenario=cloud-settings-model-select");

  await page.evaluate(() => {
    (window as any).__CLOUD_AUTH_MODE__ = "openai_chatgpt_oauth";
    (window as any).__CLOUD_TEST_BEHAVIOR__ = "openai-oauth-instructions-required";
  });
  await enableCloudLab(page);
  await page.getByTestId("cloud-auth-mode-openai_chatgpt_oauth").click();
  await page.getByTestId("cloud-auth-login").click();
  await page.getByTestId("cloud-model-refresh").click();
  await page.getByTestId("cloud-model-test").click();
  await expect(page.getByText(/OpenAI 实验登录通道要求 Responses 请求携带 instructions/)).toBeVisible();

  await page.evaluate(() => {
    (window as any).__CLOUD_AUTH_MODE__ = "gemini_google_oauth";
    (window as any).__CLOUD_TEST_BEHAVIOR__ = "gemini-oauth-scope-insufficient";
  });
  await page.getByTestId("cloud-auth-mode-gemini_google_oauth").click();
  await page.getByTestId("cloud-auth-login").click();
  await page.getByTestId("cloud-model-refresh").click();
  await page.getByTestId("cloud-model-test").click();
  await expect(page.getByText(/Gemini 登录 token 缺少 cloud-platform 授权范围/)).toBeVisible();
});

test("Gemini Google login replaces stale OpenAI endpoint before testing", async ({ page }) => {
  await page.goto("/?e2eScenario=cloud-settings-model-select");
  await page.evaluate(() => {
    (window as any).__CLOUD_AUTH_MODE__ = "gemini_google_oauth";
  });

  await enableCloudLab(page);
  await page.getByTestId("cloud-auth-mode-gemini_google_oauth").click();
  await page.getByTestId("cloud-auth-login").click();
  await expect(page.getByText(/已登录 · gemini@example\.com/)).toBeVisible();
  await page.getByTestId("cloud-model-refresh").click();
  await page.getByTestId("cloud-model-test").click();

  const requests = await page.evaluate(() => (window as any).__CLOUD_REQUESTS__ ?? []);
  const probe = requests.find((request: any) => request.method === "POST" && request.url.includes("v1internal:generateContent"));
  expect(probe?.url).toBe("https://cloudcode-pa.googleapis.com/v1internal:generateContent");
  expect(probe?.body?.model).toBe("gemini-3-pro-preview");
  expect(probe?.body?.project).toBeUndefined();
  expect(probe?.body?.request?.contents?.[0]?.parts?.[0]?.text).toContain("ok");
});

test("saved Gemini OAuth configs repair stale OpenAI endpoints at test time", async ({ page }) => {
  await page.goto("/?e2eScenario=cloud-settings-model-select");
  await page.evaluate(() => {
    const snapshot = (window as any).__CODELY_E2E__?.getSnapshot?.();
    const server = snapshot?.cloudServers?.[0];
    (window as any).__CODELY_E2E__?.setCloudServers?.([
      {
        ...server,
        provider: "Gemini",
        protocol: "gemini",
        endpoint: "https://api.openai.com/v1",
        model: "gemini-2.5-pro",
        auth: {
          mode: "gemini_google_oauth",
          status: "connected",
          tokenRef: server?.id ?? "demo-cloud",
          email: "gemini@example.com",
        },
      },
    ], server?.id);
  });

  await enableCloudLab(page);
  await expect(page.getByTestId("cloud-model-input")).toHaveValue("gemini-2.5-pro");
  await page.getByTestId("cloud-model-test").click();

  const requests = await page.evaluate(() => (window as any).__CLOUD_REQUESTS__ ?? []);
  const probe = requests.find((request: any) => request.method === "POST" && request.url.includes("v1internal:generateContent"));
  expect(probe?.url).toBe("https://cloudcode-pa.googleapis.com/v1internal:generateContent");
  expect(probe?.body?.model).toBe("gemini-2.5-pro");
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

  await expect(page.getByRole("heading", { name: "云端接口配置" })).toBeVisible();
  await expect(page.getByTestId("cloud-server-item")).toHaveCount(1);
  await expect(page.getByTestId("cloud-server-item")).toContainText("Demo Gateway");
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
  await page.getByText("详细设置").click();
  const reasoningEffortSelect = page.locator("select").filter({
    has: page.locator("option[value='xhigh']"),
  });
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

test("cloud model test shows a persistent connected check and keeps the base probe minimal", async ({ page }) => {
  await page.goto("/?e2eScenario=cloud-settings-model-select");

  await page.getByTestId("cloud-model-refresh").click();
  await expect(page.getByTestId("cloud-model-select")).toHaveValue("gpt-4.1");

  await page.getByTestId("cloud-model-test").click();
  await expect(page.getByTestId("cloud-model-connected-status")).toContainText("已连通 gpt-4.1");
  await expect(page.getByTestId("cloud-model-connected-status")).toBeVisible();

  const postRequests = await page.evaluate(() =>
    ((window as any).__CLOUD_REQUESTS__ ?? []).filter((request: any) => request.method === "POST"),
  );
  expect(postRequests[0].url).toContain("/responses");
  expect(postRequests[0].body.store).toBeUndefined();
  expect(postRequests[0].body.reasoning).toBeUndefined();
  expect(typeof postRequests[0].body.input).toBe("string");
  expect(postRequests.some((request: any) => request.body?.store === false)).toBeTruthy();

  await page.waitForTimeout(5200);
  await expect(page.getByTestId("cloud-model-connected-status")).toBeVisible();

  await page.getByTestId("cloud-model-select").selectOption("qwen-max");
  await expect(page.getByTestId("cloud-model-connected-status")).toHaveCount(0);
});

test("cloud model test keeps the connected check when advanced Responses params fail", async ({ page }) => {
  await page.goto("/?e2eScenario=cloud-settings-model-select");
  await page.evaluate(() => {
    (window as any).__CLOUD_TEST_BEHAVIOR__ = "advanced-fails";
  });

  await page.getByTestId("cloud-model-refresh").click();
  await page.getByTestId("cloud-model-test").click();

  await expect(page.getByTestId("cloud-model-connected-status")).toContainText("已连通 gpt-4.1");
  await expect(page.getByText(/基础连接可用，但 store\/reasoning 高级参数未通过/)).toBeVisible();
});

test("cloud model test falls back from Responses to Chat Completions and records the switch", async ({ page }) => {
  await page.goto("/?e2eScenario=cloud-settings-model-select");
  await page.evaluate(() => {
    (window as any).__CLOUD_TEST_BEHAVIOR__ = "responses-fail-chat-succeeds";
  });

  await page.getByTestId("cloud-model-refresh").click();
  await page.getByTestId("cloud-model-test").click();

  await expect(page.getByTestId("cloud-model-connected-status")).toContainText("已连通 gpt-4.1，已自动切换到 Chat Completions");
  await page.getByText("详细设置").click();
  const apiFormatSelect = page.locator("select").filter({
    has: page.locator("option[value='responses']"),
  });
  await expect(apiFormatSelect).toHaveValue("chat_completions");
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
  await secondServer.locator("button[title='删除服务器']").click();

  await expect(page.getByTestId("cloud-server-item")).toHaveCount(1);
  await expect(page.getByTestId("cloud-server-item")).toContainText("Demo Gateway");
  await expect
    .poll(async () =>
      page.evaluate(() => (window as any).__CODELY_E2E__?.getSnapshot?.().cloudServerCount ?? null),
    )
    .toBe(1);
});
