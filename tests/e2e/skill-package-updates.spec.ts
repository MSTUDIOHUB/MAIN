import { expect, test, type Page } from "@playwright/test";

const OLD_ID = "a".repeat(64);
const NEW_ID = "b".repeat(64);
const ZIP_ID = "c".repeat(64);
const REGISTRATION_ID = "team-package";
const PACKAGE_NAME = "Team workflow";
const SOURCE = { repository: "owner/skills", branch: "main" };

test.beforeEach(async ({ page }) => {
  await page.addInitScript(({ oldId, newId, zipId, registrationId, packageName, source }) => {
    const entryPoints = (id: string) => id === oldId ? ["skills/review/SKILL.md"]
      : ["skills/review/SKILL.md", "skills/release/SKILL.md"];
    if (!sessionStorage.getItem("__SKILL_PACKAGE_UPDATES_RESET__")) {
      localStorage.clear();
      localStorage.setItem("local-agent-ide", JSON.stringify({ version: 2, state: {
        config: { language: "zh", themeMode: "dark", sessionRecordingEnabled: false },
        skills: [{
          id: registrationId, name: packageName, desc: "Keep this description", content: "", type: "package",
          active: false, isBuiltIn: false, allowImplicitInvocation: false,
          packageStorage: { kind: "global", packageId: oldId },
          entryPoint: entryPoints(oldId)[0], entryPoints: entryPoints(oldId), githubSource: source,
        }],
      } }));
      sessionStorage.setItem("__SKILL_PACKAGE_UPDATES_RESET__", "1");
    }
    const state = (window as any).__SKILL_PACKAGE_UPDATES_E2E__ = {
      fetches: [] as unknown[], nextPackageId: newId, zipPackageId: zipId, fetchError: "",
      holdFetch: false, pending: [] as Array<() => void>, failNextPersist: false, inferenceRequests: 0,
      sourceMismatch: false,
    };
    const originalSetItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (key === "local-agent-ide" && state.failNextPersist) {
        state.failNextPersist = false;
        throw new Error("TEST_STORAGE_WRITE_FAILED");
      }
      return originalSetItem.call(this, key, value);
    };
    const meta = (id: string, githubSource?: { repository: string; branch: string }) => ({
      packageId: id, name: "Downloaded Team Skills", entryPoint: entryPoints(id)[0],
      entryPoints: entryPoints(id), files: entryPoints(id), reused: false,
      ...(githubSource ? { githubSource } : {}),
    });
    const document = (relativePath: string) => `---\nname: ${relativePath.includes("release") ? "release" : "review"}\ndescription: Package update fixture.\n---\nVerified package instructions.`;
    let callbackId = 1;
    const internals = ((window as any).__TAURI_INTERNALS__ ??= {});
    (window as any).__TAURI_EVENT_PLUGIN_INTERNALS__ ??= { unregisterListener: () => {} };
    internals.metadata = { currentWindow: { label: "main" }, currentWebview: { label: "main" } };
    internals.transformCallback = () => callbackId++;
    internals.unregisterCallback = () => {};
    internals.invoke = async (command: string, args?: Record<string, any>) => {
      if (command === "plugin:event|listen") return callbackId++;
      if (command === "plugin:event|unlisten") return null;
      if (command === "get_system_memory") return { total_gb: 32, available_gb: 24 };
      if (command === "read_debug_log") return { path: "/tmp/main-package-updates.log", content: "", truncated: false };
      if (command === "get_workspace_root") return "";
      if (command === "set_workspace_root" || command === "canonicalize_workspace_path") return String(args?.path || "");
      if (command === "list_project_sessions" || command === "rebuild_project_sessions_index" || command === "discover_personal_agent_skills" || command === "glob_search") return [];
      if (command === "save_project_session") return args?.session;
      if (command === "read_file") throw new Error("ENOENT");
      if (command === "plugin:dialog|open") return "/tmp/team-skills.zip";
      if (command === "extract_global_skill_package") return meta(state.zipPackageId);
      if (command === "fetch_and_install_github_skill_package") {
        state.fetches.push(args);
        const resultId = state.nextPackageId;
        if (state.holdFetch) await new Promise<void>((release) => state.pending.push(release));
        if (state.fetchError) throw new Error(state.fetchError);
        return meta(resultId, { repository: state.sourceMismatch ? "different/repository" : String(args?.repoOrUrl), branch: String(args?.branch || "main") });
      }
      if (command === "inspect_global_skill_package") return meta(String(args?.packageId));
      if (command === "load_global_skill_package_catalog") return {
        meta: meta(String(args?.packageId)),
        documents: entryPoints(String(args?.packageId)).map((relativePath) => ({ relativePath, content: document(relativePath) })),
      };
      if (command === "read_global_skill_package_file") return document(String(args?.relativePath));
      if (command === "get_git_status") return { isRepo: false, gitAvailable: true, clean: true };
      if (command === "main_update_status") return { status: "idle" };
      if (command === "proxy_request") {
        if (/Interpret MAIN's current user request|\[MAIN RUNTIME V2\]/.test(String(args?.body))) state.inferenceRequests++;
        return JSON.stringify({ output_text: "No model execution is needed for package management." });
      }
      return null;
    };
  }, { oldId: OLD_ID, newId: NEW_ID, zipId: ZIP_ID, registrationId: REGISTRATION_ID, packageName: PACKAGE_NAME, source: SOURCE });
  await page.goto("/?e2eScenario=global-chat-tool-scope");
  await expect(page.getByRole("button", { name: "技能与提示词", exact: true })).toBeVisible();
});

async function openSkills(page: Page) {
  await page.getByRole("button", { name: "技能与提示词", exact: true }).click();
  return page.getByRole("heading", { name: "技能与提示词", exact: true })
    .locator("xpath=ancestor::div[contains(@class, 'rounded-xl')][1]");
}

async function registration(page: Page) {
  return page.evaluate(async (id) => {
    // @ts-expect-error Vite browser module URL.
    const { useAppStore } = await import("/src/store/useAppStore.ts");
    return useAppStore.getState().skills.find((skill: { id: string }) => skill.id === id);
  }, REGISTRATION_ID);
}

async function fixture(page: Page, patch: Record<string, unknown>) {
  await page.evaluate((next) => Object.assign((window as any).__SKILL_PACKAGE_UPDATES_E2E__, next), patch);
}

test.afterEach(async ({ page }) => {
  expect(await page.evaluate(() => (window as any).__SKILL_PACKAGE_UPDATES_E2E__.inferenceRequests)).toBe(0);
});

test("GitHub checks stage a verified candidate and explicit Update preserves registration policy across reload", async ({ page }) => {
  const modal = await openSkills(page);
  const row = modal.getByTestId(`skill-package-update-${REGISTRATION_ID}`);
  await expect(row).toContainText("owner/skills @ main");
  await expect(row).toContainText("手动检查会下载并校验仓库快照");
  expect(await page.evaluate(() => (window as any).__SKILL_PACKAGE_UPDATES_E2E__.fetches)).toEqual([]);
  const original = await registration(page);
  await row.getByRole("button", { name: `检查更新: ${PACKAGE_NAME}`, exact: true }).click();
  await expect(row.getByText("可用更新", { exact: true })).toBeVisible();
  await expect(row).toContainText("aaaaaaaaaaaa → bbbbbbbbbbbb");
  await expect(row).toContainText("包含 1 个技能 → 包含 2 个技能");
  expect(await registration(page)).toEqual(original);
  expect(await page.evaluate(() => (window as any).__SKILL_PACKAGE_UPDATES_E2E__.fetches)).toEqual([{ repoOrUrl: "owner/skills", branch: "main" }]);
  await row.getByRole("button", { name: `更新: ${PACKAGE_NAME}`, exact: true }).click();
  await expect(row.getByRole("status")).toContainText("下次启动执行生效");
  expect(await registration(page)).toMatchObject({
    id: REGISTRATION_ID, name: PACKAGE_NAME, desc: "Keep this description", active: false,
    allowImplicitInvocation: false, packageStorage: { kind: "global", packageId: NEW_ID },
    githubSource: SOURCE, entryPoints: ["skills/review/SKILL.md", "skills/release/SKILL.md"],
  });
  await modal.getByRole("button", { name: "完成", exact: true }).click();
  await page.reload();
  await openSkills(page);
  expect((await registration(page)).packageStorage.packageId).toBe(NEW_ID);
  expect(await page.evaluate(() => (window as any).__SKILL_PACKAGE_UPDATES_E2E__.fetches)).toEqual([]);
});

test("latest, network failure and source mismatch show localized retryable states", async ({ page }) => {
  const row = (await openSkills(page)).getByTestId(`skill-package-update-${REGISTRATION_ID}`);
  const check = row.getByRole("button", { name: `检查更新: ${PACKAGE_NAME}`, exact: true });
  await fixture(page, { nextPackageId: OLD_ID });
  await check.click();
  await expect(row.getByRole("status")).toHaveText("已是最新版本。");
  await expect(row.getByRole("button", { name: `更新: ${PACKAGE_NAME}`, exact: true })).toHaveCount(0);
  await fixture(page, { fetchError: "RAW_NETWORK_FAILURE" });
  await check.click();
  await expect(row.getByRole("status")).toContainText("请检查网络和仓库分支后重试");
  await expect(row).not.toContainText("RAW_NETWORK_FAILURE");
  await fixture(page, { fetchError: "", nextPackageId: NEW_ID, sourceMismatch: true });
  await check.click();
  await expect(row.getByRole("status")).toContainText("GitHub 来源无法验证");
  await fixture(page, { sourceMismatch: false });
  await check.click();
  await expect(row.getByText("可用更新", { exact: true })).toBeVisible();
  expect((await registration(page)).packageStorage.packageId).toBe(OLD_ID);
});

test("cancel and closing discard candidates and ignore a late check response", async ({ page }) => {
  const modal = await openSkills(page);
  const row = modal.getByTestId(`skill-package-update-${REGISTRATION_ID}`);
  const check = row.getByRole("button", { name: `检查更新: ${PACKAGE_NAME}`, exact: true });
  await check.click();
  await expect(row.getByText("可用更新", { exact: true })).toBeVisible();
  await row.getByRole("button", { name: `取消更新: ${PACKAGE_NAME}`, exact: true }).click();
  await expect(row.getByText("可用更新", { exact: true })).toHaveCount(0);
  await fixture(page, { holdFetch: true });
  await check.click();
  await expect(check).toBeDisabled();
  await expect(check).toHaveText("检查中…");
  await modal.getByRole("button", { name: "关闭", exact: true }).click();
  await page.evaluate(() => (window as any).__SKILL_PACKAGE_UPDATES_E2E__.pending.splice(0).forEach((release: () => void) => release()));
  await openSkills(page);
  await expect(row.getByText("可用更新", { exact: true })).toHaveCount(0);
  await expect(check).toBeEnabled();
  expect((await registration(page)).packageStorage.packageId).toBe(OLD_ID);
});

test("a policy edit invalidates both in-flight checks and staged candidates", async ({ page }) => {
  const modal = await openSkills(page);
  const row = modal.getByTestId(`skill-package-update-${REGISTRATION_ID}`);
  const check = row.getByRole("button", { name: `检查更新: ${PACKAGE_NAME}`, exact: true });
  const enabled = modal.getByRole("switch", { name: `${PACKAGE_NAME}: 启用`, exact: true });
  await fixture(page, { holdFetch: true });
  await check.click();
  await expect(check).toBeDisabled();
  await enabled.click();
  await expect(row.getByRole("status")).toContainText("请重新检查更新");
  await page.evaluate(() => (window as any).__SKILL_PACKAGE_UPDATES_E2E__.pending.splice(0).forEach((release: () => void) => release()));
  await fixture(page, { holdFetch: false });
  await check.click();
  await expect(row.getByText("可用更新", { exact: true })).toBeVisible();
  await enabled.click();
  await expect(row.getByRole("status")).toContainText("请重新检查更新");
  await expect(row.getByRole("button", { name: `更新: ${PACKAGE_NAME}`, exact: true })).toHaveCount(0);
  expect((await registration(page)).packageStorage.packageId).toBe(OLD_ID);
});

test("an already-installed candidate reports conflict without changing either registration", async ({ page }) => {
  await page.evaluate(async ({ id, nextId }) => {
    // @ts-expect-error Vite browser module URL.
    const { useAppStore } = await import("/src/store/useAppStore.ts");
    const state = useAppStore.getState();
    const original = state.skills.find((skill: { id: string }) => skill.id === id);
    state.setSkills([...state.skills, { ...original, id: "other-registration", name: "Other installation", active: true, packageStorage: { kind: "global", packageId: nextId } }]);
  }, { id: REGISTRATION_ID, nextId: NEW_ID });
  const row = (await openSkills(page)).getByTestId(`skill-package-update-${REGISTRATION_ID}`);
  const original = await registration(page);
  await row.getByRole("button", { name: `检查更新: ${PACKAGE_NAME}`, exact: true }).click();
  await row.getByRole("button", { name: `更新: ${PACKAGE_NAME}`, exact: true }).click();
  await expect(row.getByRole("status")).toContainText("该版本已另行安装");
  expect(await registration(page)).toEqual(original);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("local-agent-ide") || "{}").state.skills.length)).toBe(2);
});

test("a failed registration save reports a save error and can retry the same verified candidate", async ({ page }) => {
  const row = (await openSkills(page)).getByTestId(`skill-package-update-${REGISTRATION_ID}`);
  await row.getByRole("button", { name: `检查更新: ${PACKAGE_NAME}`, exact: true }).click();
  const apply = row.getByRole("button", { name: `更新: ${PACKAGE_NAME}`, exact: true });
  await expect(apply).toBeVisible();
  await apply.evaluate((button) => {
    (window as any).__SKILL_PACKAGE_UPDATES_E2E__.failNextPersist = true;
    (button as HTMLButtonElement).click();
  });
  await expect(row.getByRole("status")).toHaveText("无法保存更新，请重试。");
  expect((await registration(page)).packageStorage.packageId).toBe(OLD_ID);
  await apply.click();
  await expect(row.getByRole("status")).toContainText("已更新");
  expect((await registration(page)).packageStorage.packageId).toBe(NEW_ID);
  expect(await page.evaluate(() => (window as any).__SKILL_PACKAGE_UPDATES_E2E__.fetches.length)).toBe(1);
});

test("legacy ZIP provenance is bound only by a successful GitHub download and save", async ({ page }) => {
  await page.evaluate(async () => {
    // @ts-expect-error Vite browser module URL.
    const { useAppStore } = await import("/src/store/useAppStore.ts");
    const state = useAppStore.getState();
    state.setSkills(state.skills.map(({ githubSource: _source, ...skill }: any) => skill));
  });
  const modal = await openSkills(page);
  const check = modal.getByRole("button", { name: `检查更新: ${PACKAGE_NAME}`, exact: true });
  await expect(check).toHaveCount(0);
  const edit = modal.getByRole("button", { name: `编辑技能: ${PACKAGE_NAME}`, exact: true });
  await edit.click();
  await modal.getByRole("textbox", { name: "GitHub 仓库或 URL", exact: true }).fill("owner/rebound");
  await modal.getByRole("textbox", { name: "分支（默认 main）", exact: true }).fill("stable");
  await modal.getByRole("button", { name: "更新技能", exact: true }).click();
  expect((await registration(page)).githubSource).toBeUndefined();
  await expect(check).toHaveCount(0);
  await edit.click();
  await modal.getByRole("textbox", { name: "GitHub 仓库或 URL", exact: true }).fill("owner/rebound");
  await modal.getByRole("textbox", { name: "分支（默认 main）", exact: true }).fill("stable");
  await fixture(page, { nextPackageId: OLD_ID });
  await modal.getByRole("button", { name: "从 GitHub 安装", exact: true }).click();
  await expect(modal.getByText("发现 1 个技能", { exact: true })).toBeVisible();
  expect((await registration(page)).githubSource).toBeUndefined();
  await modal.getByRole("button", { name: "更新技能", exact: true }).click();
  expect(await registration(page)).toMatchObject({ id: REGISTRATION_ID, name: PACKAGE_NAME, active: false, allowImplicitInvocation: false, githubSource: { repository: "owner/rebound", branch: "stable" } });
  await expect(check).toBeVisible();
  // A same-byte ZIP keeps verified provenance; a different ZIP cannot inherit it.
  await edit.click();
  await fixture(page, { zipPackageId: OLD_ID });
  await modal.getByRole("button", { name: "上传 ZIP", exact: true }).click();
  await modal.getByRole("button", { name: "更新技能", exact: true }).click();
  expect((await registration(page)).githubSource).toEqual({ repository: "owner/rebound", branch: "stable" });
  await edit.click();
  await fixture(page, { zipPackageId: ZIP_ID });
  await modal.getByRole("button", { name: "上传 ZIP", exact: true }).click();
  await modal.getByRole("button", { name: "更新技能", exact: true }).click();
  expect((await registration(page)).githubSource).toBeUndefined();
  await expect(check).toHaveCount(0);
});

for (const theme of ["light", "dark", "black"] as const) {
  test(`GitHub candidate preview remains readable in ${theme} theme`, async ({ page }, testInfo) => {
    await page.evaluate((mode) => (window as any).__CODELY_E2E__.setThemeMode(mode), theme);
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    const modal = await openSkills(page);
    const row = modal.getByTestId(`skill-package-update-${REGISTRATION_ID}`);
    await row.getByRole("button", { name: `检查更新: ${PACKAGE_NAME}`, exact: true }).click();
    await expect(row.getByText("可用更新", { exact: true })).toBeVisible();
    await expect(row.getByRole("button", { name: `更新: ${PACKAGE_NAME}`, exact: true })).toBeVisible();
    await modal.screenshot({ path: testInfo.outputPath(`github-skill-update-${theme}.png`), animations: "disabled" });
  });
}
