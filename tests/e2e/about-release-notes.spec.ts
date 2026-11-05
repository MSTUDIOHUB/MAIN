import { expect, test } from "@playwright/test";
import fs from "node:fs";

const RELEASE_NOTES = fs.readFileSync("docs/releases/Release_Notes_2.3.8_ZH.md", "utf8");
const RELEASE_URL = "https://github.com/MSTUDIOHUB/MAIN-Releases/releases/tag/v2.3.8";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(({ notes }) => {
    localStorage.clear();
    localStorage.setItem("main:lastDesktopUpdateCheckAt", String(Date.now()));
    const state = (window as any).__MAIN_UPDATE_E2E__ = { notes, checks: 0, opens: [] as string[], installs: 0 };
    let callbackId = 1;
    const internals = ((window as any).__TAURI_INTERNALS__ ??= {});
    (window as any).__TAURI_EVENT_PLUGIN_INTERNALS__ ??= { unregisterListener: () => {} };
    internals.metadata = { currentWindow: { label: "main" }, currentWebview: { label: "main" } };
    internals.transformCallback = () => callbackId++;
    internals.unregisterCallback = () => {};
    internals.invoke = async (command: string, args?: any) => {
      if (command === "plugin:event|listen") return callbackId++;
      if (command === "plugin:event|unlisten") return null;
      if (command === "plugin:app|version") return "2.3.7";
      if (command === "plugin:updater|check") {
        state.checks++;
        return { rid: state.checks, currentVersion: "2.3.7", version: "2.3.8", body: state.notes, date: "2026-11-05T00:00:00Z" };
      }
      if (command.startsWith("plugin:updater|download") || command === "plugin:updater|install") { state.installs++; return null; }
      if (command === "plugin:opener|open_url") { state.opens.push(args.url); return null; }
      if (command === "get_system_memory") return { total_gb: 32, available_gb: 24 };
      if (command === "get_workspace_root") return "";
      if (command === "set_workspace_root" || command === "canonicalize_workspace_path") return String(args?.path || "");
      if (["list_project_sessions", "rebuild_project_sessions_index", "discover_personal_agent_skills", "glob_search"].includes(command)) return [];
      if (command === "read_file") throw new Error("ENOENT");
      if (command === "get_git_status") return { isRepo: false, gitAvailable: true, clean: true };
      if (command === "main_update_status") return { status: "idle" };
      return null;
    };
  }, { notes: RELEASE_NOTES });
  await page.goto("/?e2eScenario=global-chat-tool-scope");
  await page.getByTestId("model-settings-button").click();
  await page.getByTestId("settings-tab-about").click();
});

for (const theme of ["light", "dark", "black"] as const) {
  test(`About renders the complete authored updater notes in ${theme} mode`, async ({ page }, testInfo) => {
    expect(RELEASE_NOTES.length).toBeGreaterThan(520);
    await page.evaluate((mode) => (window as any).__CODELY_E2E__.setThemeMode(mode), theme);
    await page.getByTestId("settings-check-update").click();
    const notes = page.getByTestId("settings-release-notes");
    await expect(notes.locator('[data-markdown-heading-level="1"]')).toContainText("MAIN 2.3.8 发布说明");
    await expect(notes).toContainText("GitHub 技能包手动检查与确认更新");
    await expect(notes).toContainText(RELEASE_NOTES.trim().split("\n").at(-1)!);
    await expect(notes.getByRole("link", { name: "提交问题", exact: true })).toHaveAttribute("href", "https://github.com/MSTUDIOHUB/MAIN/issues");
    await page.getByTestId("settings-release-notes-open").click();
    expect(await page.evaluate(() => (window as any).__MAIN_UPDATE_E2E__.opens)).toEqual([RELEASE_URL]);
    expect(await page.evaluate(() => (window as any).__MAIN_UPDATE_E2E__.checks)).toBe(1);
    await notes.screenshot({ path: testInfo.outputPath(`about-release-notes-${theme}.png`), animations: "disabled" });
    expect(await page.evaluate(() => (window as any).__MAIN_UPDATE_E2E__.installs)).toBe(0);
  });
}

test("an update with no notes keeps the matching version's release page available", async ({ page }) => {
  await page.evaluate(() => { (window as any).__MAIN_UPDATE_E2E__.notes = ""; });
  await page.getByTestId("settings-check-update").click();
  await expect(page.getByTestId("settings-release-notes")).toContainText("此版本暂未提供更新说明");
  await page.getByTestId("settings-release-notes-open").click();
  expect(await page.evaluate(() => (window as any).__MAIN_UPDATE_E2E__.opens)).toEqual([RELEASE_URL]);
});
