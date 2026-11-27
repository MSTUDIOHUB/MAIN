import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";
import { invokeRuntimeToolBridge } from "./runtimeToolBridge";

const liveWorkspace = process.env.MAIN_TEST_MCP_SETTINGS_UNITY_WORKSPACE;
const workspace = liveWorkspace || "/tmp/main-mcp-settings-unity";
const otherWorkspace = "/tmp/main-mcp-settings-other";
const manualUrl = "http://127.0.0.1:8080/mcp";

interface CliUpdateFixture {
  currentVersion: string;
  latestVersion: string | null;
  applyError?: string;
  keepPreviousVersion?: boolean;
  packageManagerCommand?: string;
  managedDuringApply?: boolean;
}

async function openMcpSettings(
  page: Page, theme: "dark" | "light" | "black", httpEnabled: boolean,
  activeWorkspace = workspace, officialError?: string, cliUpdate?: CliUpdateFixture,
) {
  const versionText = liveWorkspace && await fs.readFile(path.join(liveWorkspace, "ProjectSettings/ProjectVersion.txt"), "utf8");
  const editorVersion = versionText ? /^m_EditorVersion:\s*(\S+)/m.exec(versionText)?.[1] : "6000.6.5f1";
  expect(editorVersion).toMatch(/^6000\./);
  if (liveWorkspace) {
    await page.exposeFunction("discoverLiveUnityMcp", (args: Record<string, unknown>) =>
      invokeRuntimeToolBridge(workspace, "unity_official_mcp", args));
  }
  await page.addInitScript(({ workspace, editorVersion, manualUrl, live, officialError, cliUpdate }) => {
    localStorage.clear();
    const host = window as any;
    const calls: Array<{ command: string; workspace?: string; editorVersion?: string; url?: string; method?: string; args?: unknown }> = [];
    const executablePath = "/tmp/main-mcp-settings-cli/bin/unity";
    let currentVersion = cliUpdate?.currentVersion ?? "1.1.0";
    let latestVersion = cliUpdate ? cliUpdate.latestVersion : currentVersion;
    let packageManagerCommand = cliUpdate?.managedDuringApply ? undefined : cliUpdate?.packageManagerCommand;
    const cliStatus = () => ({
      executablePath, currentVersion, latestVersion, updateAvailable: latestVersion !== null && currentVersion !== latestVersion,
      packageManagerCommand,
    });
    host.mcpSettingsCalls = calls;
    host.setMcpSettingsLatestCliVersion = (version: string) => { latestVersion = version; };
    host.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
    host.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
      transformCallback: () => 1,
      unregisterCallback() {},
      invoke: async (command: string, args: any = {}) => {
        if (command === "plugin:event|listen") return 1;
        if (command === "unity_cli_check_update") {
          calls.push({ command });
          return cliStatus();
        }
        if (command === "unity_cli_apply_update") {
          calls.push({ command, args });
          if (cliUpdate?.applyError) throw new Error(cliUpdate.applyError);
          if (cliUpdate?.managedDuringApply) packageManagerCommand = cliUpdate.packageManagerCommand;
          if (latestVersion && !packageManagerCommand && !cliUpdate?.keepPreviousVersion) currentVersion = latestVersion;
          return cliStatus();
        }
        if (command === "inspect_workspace_engine_profile") {
          return args.workspace === workspace
            ? { kind: "unity", projectRoot: ".", descriptorPath: "ProjectSettings/ProjectVersion.txt", projectVersion: editorVersion, manualPresetId: "unity6" }
            : null;
        }
        if (command === "unity_official_mcp") {
          calls.push({ command, workspace: args.workspace, editorVersion: args.editorVersion });
          if (officialError) throw new Error(officialError);
          if (cliUpdate && currentVersion === "1.0.0-beta.14") {
            throw new Error(`UNITY_OFFICIAL_MCP_CLI_TOO_OLD: ${currentVersion}`);
          }
          if (live) return host.discoverLiveUnityMcp(args);
          return { editorPid: 1234, tools: [{ name: "console", description: "Read Unity Console",
            inputSchema: { type: "object", properties: {} } }] };
        }
        if (command === "proxy_request_detailed" && args.url === manualUrl) {
          const rpc = JSON.parse(args.body);
          calls.push({ command, url: args.url, method: rpc.method });
          if (rpc.method === "notifications/initialized") return { ok: true, status: 202, body: "", headers: {} };
          const result = rpc.method === "initialize"
            ? { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "fixture" } }
            : { tools: [{ name: "manual_ping", description: "Test manual server", inputSchema: { type: "object", properties: {} } }] };
          return { ok: true, status: 200, contentType: "application/json", headers: {},
            body: JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result }) };
        }
        if (["list_project_sessions", "list_all_session_snapshots", "list_legacy_session_files"].includes(command)) return [];
        return null;
      },
    };
  }, { workspace, editorVersion, manualUrl, live: !!liveWorkspace, officialError, cliUpdate });
  await page.goto("/");
  await expect(page.getByRole("button", { name: /^(系统设置|Settings)$/ })).toBeVisible();
  await page.evaluate(async ({ activeWorkspace, theme, manualUrl, httpEnabled, workspace, otherWorkspace }) => {
    const storeUrl = performance.getEntriesByType("resource")
      .find(entry => new URL(entry.name).pathname === "/src/store/useAppStore.ts")!.name;
    const { useAppStore } = await import(storeUrl) as typeof import("/src/store/useAppStore.ts");
    (window as any).mcpSettingsStore = useAppStore;
    useAppStore.setState(state => ({
      currentWorkspace: activeWorkspace,
      currentSessionId: null,
      selectedWorkspace: activeWorkspace,
      workspaces: [
        { name: "TestCli", path: workspace, addedAt: 1, lastActiveAt: 1 },
        { name: "Other", path: otherWorkspace, addedAt: 2, lastActiveAt: 2 },
      ],
      config: { ...state.config, themeMode: theme, language: "zh", unityOfficialMcpEnabled: false },
      mcpServers: [{ name: "M", url: manualUrl, type: "http", enabled: httpEnabled }],
      mcpDiscoveredTools: [],
      mcpToolServerMap: {},
    }));
  }, { activeWorkspace, theme, manualUrl, httpEnabled, workspace, otherWorkspace });
  await page.getByRole("button", { name: "系统设置", exact: true }).click();
  await page.getByTestId("settings-tab-mcp").click();
  await page.getByRole("switch", { name: "Unity 官方 MCP", exact: true }).check();
  return { editorVersion, scan: page.getByRole("button", { name: "扫描工具", exact: true }),
    workspaceSelect: page.getByRole("combobox", { name: "扫描工作区", exact: true }),
    officialStatus: page.getByTestId("unity-official-mcp-scan-status") };
}

test("scans a selected Unity workspace without opening its session or enabling HTTP in Dark", async ({ page }) => {
  const { editorVersion, scan, officialStatus, workspaceSelect } = await openMcpSettings(page, "dark", false, "");
  await expect(workspaceSelect).toHaveValue("");
  await scan.click();
  await expect(officialStatus).toHaveText("请选择本次扫描的工作区。");
  await workspaceSelect.selectOption(workspace);
  await expect(officialStatus).toHaveCount(0);
  await scan.click();
  await expect(officialStatus).toHaveText(/连接成功，发现 [1-9]\d* 个工具/);
  await expect(page.getByText("console", { exact: true })).toBeVisible();
  await expect(page.getByText("尚未配置 MCP 服务器", { exact: true })).toHaveCount(0);
  const evidence = await page.evaluate(() => {
    const host = window as any;
    const { currentWorkspace, currentSessionId, mcpDiscoveredTools } = host.mcpSettingsStore.getState();
    return { calls: host.mcpSettingsCalls, sharedTools: mcpDiscoveredTools, currentWorkspace, currentSessionId };
  });
  expect(evidence.calls.filter((call: { command: string }) => call.command !== "unity_cli_check_update"))
    .toEqual([{ command: "unity_official_mcp", workspace, editorVersion }]);
  expect(evidence.sharedTools).toEqual([]);
  expect(evidence.currentWorkspace).toBe("");
  expect(evidence.currentSessionId).toBeNull();
  await page.getByRole("switch", { name: "Unity 官方 MCP", exact: true }).uncheck();
  await expect(officialStatus).toHaveCount(0);
  await expect(page.getByText("console", { exact: true })).toHaveCount(0);
  await scan.click();
  await expect(page.getByRole("status").filter({ hasText: "请先启用要扫描的 MCP 服务。" })).toBeVisible();
});

test("scans both official and manual servers and keeps their tools distinguishable in Light", async ({ page }) => {
  const { scan, officialStatus } = await openMcpSettings(page, "light", true);
  await scan.click();
  await expect(officialStatus).toHaveText(/连接成功，发现 [1-9]\d* 个工具/);
  await expect(page.getByRole("status").filter({ hasText: "从 1 个 HTTP MCP 服务器发现 1 个工具" })).toBeVisible();
  await expect(page.getByText("manual_ping", { exact: true })).toBeAttached();
  const sharedTools = await page.evaluate(() => (window as any).mcpSettingsStore.getState()
    .mcpDiscoveredTools.map((tool: { name: string }) => tool.name));
  expect(sharedTools).toEqual(["manual_ping"]);
});

test("shows an official workspace prerequisite without masking HTTP discovery in Black", async ({ page }) => {
  const { scan, officialStatus, workspaceSelect } = await openMcpSettings(page, "black", true);
  await workspaceSelect.selectOption(otherWorkspace);
  await scan.click();
  await expect(officialStatus).toHaveText("所选工作区未识别为 Unity 6 工程。请选择 Unity 6 工程目录。");
  await expect(page.getByRole("status").filter({ hasText: "从 1 个 HTTP MCP 服务器发现 1 个工具" })).toBeVisible();
  const calls = await page.evaluate(() => (window as any).mcpSettingsCalls);
  expect(calls.some((call: { command: string }) => call.command === "unity_official_mcp")).toBe(false);
});

for (const [failure, message] of [
  ["UNITY_OFFICIAL_MCP_CLI_TOO_OLD: 1.0.0-beta.14", "MAIN 找到的 Unity CLI 是 1.0.0-beta.14。官方 MCP 需要 1.0 正式版或更新版本。"],
  ["UNITY_OFFICIAL_MCP_EDITOR_UNAVAILABLE", "无法连接所选工作区的 Editor。请在 Unity 中打开该项目并启动 Pipeline HTTP 服务。"],
]) {
  test(`reports the exact official MCP scan failure ${failure}`, async ({ page }) => {
    const { scan, officialStatus } = await openMcpSettings(page, "dark", false, workspace, failure);
    await scan.click();
    await expect(officialStatus).toHaveText(message);
  });
}

test("updates Unity CLI on request and rescans the selected workspace", async ({ page }) => {
  const { editorVersion, officialStatus, workspaceSelect } = await openMcpSettings(page, "dark", false, otherWorkspace, undefined, {
    currentVersion: "1.0.0-beta.14", latestVersion: "1.1.0",
  });
  const updateStatus = page.getByTestId("unity-cli-update-status");
  await expect(updateStatus).toHaveText("Unity CLI 1.0.0-beta.14 可更新至 1.1.0。");
  const callsBeforeUpdate = await page.evaluate(() => (window as any).mcpSettingsCalls.map((call: { command: string }) => call.command));
  expect(callsBeforeUpdate).toEqual(["unity_cli_check_update"]);
  await workspaceSelect.selectOption(workspace);
  await page.getByRole("button", { name: "更新 Unity CLI", exact: true }).click();
  await expect(updateStatus).toHaveText("Unity CLI 已更新至 1.1.0。");
  await expect(officialStatus).toHaveText(/连接成功，发现 [1-9]\d* 个工具/);
  const evidence = await page.evaluate(() => ({
    calls: (window as any).mcpSettingsCalls,
    activeWorkspace: (window as any).mcpSettingsStore.getState().currentWorkspace,
  }));
  expect(evidence.activeWorkspace).toBe(otherWorkspace);
  expect(evidence.calls.filter((call: { command: string }) => call.command !== "unity_cli_check_update")).toEqual([
    {
      command: "unity_cli_apply_update",
      args: { expectedPath: "/tmp/main-mcp-settings-cli/bin/unity", expectedVersion: "1.0.0-beta.14", targetVersion: "1.1.0" },
    },
    { command: "unity_official_mcp", workspace, editorVersion },
  ]);
});

for (const [fixture, diagnostic] of [
  [{ applyError: "fixture network failure" }, "fixture network failure"],
  [{ keepPreviousVersion: true }, "UNITY_CLI_UPDATE_UNVERIFIED"],
] as const) test(`reports a failed CLI update (${diagnostic}) without rescanning or claiming success`, async ({ page }) => {
  const { scan, officialStatus } = await openMcpSettings(page, "light", false, workspace, undefined, {
    currentVersion: "1.0.0-beta.14", latestVersion: "1.1.0", ...fixture,
  });
  const updateStatus = page.getByTestId("unity-cli-update-status");
  await expect(updateStatus).toHaveText("Unity CLI 1.0.0-beta.14 可更新至 1.1.0。");
  await scan.click();
  await expect(officialStatus).toHaveText("MAIN 找到的 Unity CLI 是 1.0.0-beta.14。官方 MCP 需要 1.0 正式版或更新版本。");
  const updateButton = page.getByRole("button", { name: "更新 Unity CLI", exact: true });
  await updateButton.click();
  await expect(updateStatus).toHaveText(`Unity CLI 更新失败（${diagnostic}）。`);
  await expect(updateButton).toBeEnabled();
  await expect(officialStatus).toContainText("1.0.0-beta.14");
  const calls = await page.evaluate(() => (window as any).mcpSettingsCalls.map((call: { command: string }) => call.command));
  expect(calls.filter((command: string) => command !== "unity_cli_check_update"))
    .toEqual(["unity_official_mcp", "unity_cli_apply_update"]);
});

test("a manual CLI check finds newer releases even when the installed CLI supports MCP", async ({ page }) => {
  await openMcpSettings(page, "dark", false, "", undefined, {
    currentVersion: "1.1.0", latestVersion: "1.1.0",
  });
  const updateStatus = page.getByTestId("unity-cli-update-status");
  const updateButton = page.getByRole("button", { name: "更新 Unity CLI", exact: true });
  await expect(updateStatus).toContainText("1.1.0");
  await expect(updateButton).toHaveCount(0);
  await page.evaluate(() => (window as any).setMcpSettingsLatestCliVersion("1.2.0"));
  await page.getByRole("button", { name: "检查 CLI 更新", exact: true }).click();
  await expect(updateStatus).toHaveText("Unity CLI 1.1.0 可更新至 1.2.0。");
  await expect(updateButton).toBeVisible();
  const calls = await page.evaluate(() => (window as any).mcpSettingsCalls.map((call: { command: string }) => call.command));
  expect(calls).toEqual(["unity_cli_check_update", "unity_cli_check_update"]);
});

for (const managedDuringApply of [false, true]) test(`shows the package manager command when Unity CLI ownership is detected during ${managedDuringApply ? "apply" : "check"}`, async ({ page }) => {
  const { officialStatus } = await openMcpSettings(page, "black", false, workspace, undefined, {
    currentVersion: "1.1.0", latestVersion: "1.2.0", packageManagerCommand: "brew upgrade unity-cli",
    managedDuringApply,
  });
  const updateButton = page.getByRole("button", { name: "更新 Unity CLI", exact: true });
  if (managedDuringApply) await updateButton.click();
  await expect(page.getByText(/brew upgrade unity-cli/)).toBeVisible();
  await expect(updateButton).toHaveCount(0);
  await expect(page.getByTestId("unity-cli-update-status")).toHaveText("Unity CLI 1.1.0 可更新至 1.2.0。");
  await expect(officialStatus).toHaveCount(0);
  const calls = await page.evaluate(() => (window as any).mcpSettingsCalls.map((call: { command: string }) => call.command));
  expect(calls).toEqual(managedDuringApply ? ["unity_cli_check_update", "unity_cli_apply_update"] : ["unity_cli_check_update"]);
});

test("keeps official MCP scanning available when the latest CLI version is unavailable", async ({ page }) => {
  const { scan, officialStatus } = await openMcpSettings(page, "black", false, workspace, undefined, {
    currentVersion: "1.1.0", latestVersion: null,
  });
  await expect(page.getByTestId("unity-cli-update-status"))
    .toHaveText("当前 Unity CLI 版本为 1.1.0。暂时无法查询最新版本。");
  await expect(page.getByRole("button", { name: "更新 Unity CLI", exact: true })).toHaveCount(0);
  await scan.click();
  await expect(officialStatus).toHaveText(/连接成功，发现 [1-9]\d* 个工具/);
});

test("opens the add HTTP MCP dialog from the toolbar and submits with Enter in Dark", async ({ page }, testInfo) => {
  const { scan } = await openMcpSettings(page, "dark", false);
  const trigger = page.getByRole("button", { name: "添加 HTTP MCP 服务器", exact: true });
  const dialog = page.getByRole("dialog", { name: "添加 HTTP MCP 服务器", exact: true });
  const name = dialog.getByRole("textbox", { name: "服务器名称", exact: true });
  const address = dialog.getByRole("textbox", { name: "服务器地址", exact: true });
  const configured = { name: "Fixture Added MCP", url: "http://127.0.0.1:8280/mcp", type: "http", enabled: true };
  await expect(trigger).toBeVisible();
  await expect(page.getByRole("textbox", { name: "服务器名称", exact: true })).toHaveCount(0);
  const scanBox = (await scan.boundingBox())!;
  const triggerBox = (await trigger.boundingBox())!;
  expect(triggerBox.x).toBeGreaterThanOrEqual(scanBox.x + scanBox.width);
  expect(Math.abs((scanBox.y + scanBox.height / 2) - (triggerBox.y + triggerBox.height / 2))).toBeLessThan(5);

  await trigger.press("Enter");
  await expect(dialog).toBeVisible();
  await expect(name).toBeFocused();
  await name.fill(configured.name);
  await address.fill(configured.url);
  await page.screenshot({ path: testInfo.outputPath("http-mcp-add-dark.png") });
  await address.press("Enter");
  await expect(dialog).toHaveCount(0);
  await expect(page.getByText(configured.name, { exact: true })).toBeVisible();
  const servers = await page.evaluate(() => (window as any).mcpSettingsStore.getState().mcpServers);
  expect(servers).toContainEqual(configured);
});

for (const theme of ["light", "black"] as const) {
  test(`dismisses the HTTP MCP add dialog and restores Escape focus in ${theme}`, async ({ page }, testInfo) => {
    await openMcpSettings(page, theme, false);
    const trigger = page.getByRole("button", { name: "添加 HTTP MCP 服务器", exact: true });
    const dialog = page.getByRole("dialog", { name: "添加 HTTP MCP 服务器", exact: true });
    const name = dialog.getByRole("textbox", { name: "服务器名称", exact: true });
    await expect(dialog).toHaveCount(0);
    await trigger.click();
    await expect(name).toBeFocused();
    await page.screenshot({ path: testInfo.outputPath(`http-mcp-add-${theme}.png`) });
    await name.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(trigger).toBeFocused();

    await trigger.click();
    await expect(dialog).toBeVisible();
    await page.getByRole("heading", { name: "MCP 服务器", exact: true }).click();
    await expect(dialog).toHaveCount(0);
  });
}
