import { expect, test, type Page } from "@playwright/test";

const WORKSPACE_A = "/tmp/skill-picker-a";
const WORKSPACE_B = "/tmp/skill-picker-b";

async function seedPicker(page: Page, theme = "dark", empty = false) {
  await page.addInitScript(({ theme, empty, workspaceA, workspaceB }) => {
    localStorage.clear();
    const now = Date.now();
    const session = (id: number, title: string) => ({ id, title, active: true, messages: [], date: new Date(now).toISOString(), storageStatus: "temporary", recordingDisabled: true });
    const sessions = { [workspaceA]: [session(101, "Picker A chat")], [workspaceB]: [session(102, "Picker B chat")] };
    const personal = (name: string, platformSource = "codex") => ({
      entryPath: `/home/skills/${name}/SKILL.md`, basePath: `/home/skills/${name}`, platformSource, scope: "personal",
      content: `---\nname: ${name}\ndescription: External ${name} instructions.\n---\n${name} body`, openaiYaml: null, supportingFiles: [],
    });
    const docs = [personal("external-auto"), personal("external-manual", "claude"), personal("external-disabled"), personal("external-unadded")];
    const panel = (id: string, name: string, manual = false, active = true) => ({ id, name, desc: `${name} release checklist`, content: `${name} exact instructions`, type: "instruction", active, allowImplicitInvocation: !manual });
    localStorage.setItem("local-agent-ide", JSON.stringify({ version: 2, state: {
      config: { language: "zh", themeMode: theme, sessionRecordingEnabled: false, activeProfile: "local", workflowMode: "chat", local: { provider: "LM Studio", endpoint: "http://127.0.0.1:1234/v1", model: "test-model", contextLimit: 16384, apiKey: "" } },
      skills: empty ? [] : [panel("alpha", "alpha-review"), panel("beta", "beta-review", true), panel("off", "inactive-review", false, false), panel("duplicate-a", "same-name"), panel("duplicate-b", "same-name", true)],
      externalSkillSelections: empty ? [] : [
        { entryPath: docs[0].entryPath, workspaceScope: null, mode: "auto" },
        { entryPath: docs[1].entryPath, workspaceScope: null, mode: "manual" },
        { entryPath: docs[2].entryPath, workspaceScope: null, mode: "disabled" },
        { entryPath: "/home/skills/workspace-a-only/SKILL.md", workspaceScope: workspaceA, mode: "auto" },
        { entryPath: "/home/skills/workspace-b-only/SKILL.md", workspaceScope: workspaceB, mode: "manual" },
      ],
      currentWorkspace: workspaceA, selectedWorkspace: workspaceA, currentSessionId: 101,
      workspaces: [{ path: workspaceA, name: "Picker A", addedAt: now }, { path: workspaceB, name: "Picker B", addedAt: now }],
      sessionsByWorkspace: sessions, activeSessionByWorkspace: { [workspaceA]: 101, [workspaceB]: 102 }, selectedMainModeKey: "main_mode",
    } }));
    const state = (window as any).__SKILL_PICKER_E2E__ = {
      discoveryCalls: [] as string[], pending: [] as Array<{ workspace: string; release: () => void }>, holdWorkspaceA: false, sends: 0,
    };
    let activeWorkspace = workspaceA;
    let callbackId = 1;
    const internals = ((window as any).__TAURI_INTERNALS__ ??= {});
    (window as any).__TAURI_EVENT_PLUGIN_INTERNALS__ ??= { unregisterListener: () => {} };
    internals.metadata = { currentWindow: { label: "main" }, currentWebview: { label: "main" } };
    internals.transformCallback = () => callbackId++;
    internals.unregisterCallback = () => {};
    internals.invoke = async (command: string, args?: any) => {
      if (command === "plugin:event|listen") return callbackId++;
      if (command === "plugin:event|unlisten") return null;
      if (command === "get_system_memory") return { total_gb: 32, available_gb: 24 };
      if (command === "get_workspace_root") return activeWorkspace;
      if (command === "canonicalize_workspace_path") return args.path;
      if (command === "set_workspace_root") { activeWorkspace = args.path; return activeWorkspace; }
      if (command === "list_project_sessions" || command === "rebuild_project_sessions_index") return sessions[args.workspace] || [];
      if (command === "load_project_session" || command === "load_project_session_meta") return sessions[args.workspace]?.find((item) => item.id === Number(args.sessionId)) || null;
      if (command === "save_project_session") return args.session;
      if (command === "discover_personal_agent_skills") {
        const workspace = String(args?.workspace || "");
        state.discoveryCalls.push(workspace);
        if (state.holdWorkspaceA && workspace === workspaceA) await new Promise<void>((release) => state.pending.push({ workspace, release }));
        return empty ? [] : [...docs, personal(workspace === workspaceB ? "workspace-b-only" : "workspace-a-only")];
      }
      if (command === "glob_search") return [];
      if (command === "read_file") throw new Error("ENOENT");
      if (command === "get_git_status") return { isRepo: false, gitAvailable: true, clean: true };
      if (command === "main_update_status") return { status: "idle" };
      if (command === "proxy_request") {
        if (String(args.body || "").includes("Interpret MAIN's current user request.") || String(args.body || "").includes("[MAIN RUNTIME V2]")) state.sends++;
        return JSON.stringify({ output_text: "picker-test" });
      }
      return null;
    };
  }, { theme, empty, workspaceA: WORKSPACE_A, workspaceB: WORKSPACE_B });
  await page.goto("/");
  await expect(page.getByTestId("composer-textarea")).toBeVisible();
}

test("dollar opens only admitted auto and manual Skills, filters locally, and supports keyboard selection", async ({ page }) => {
  await seedPicker(page);
  const input = page.getByTestId("composer-textarea");
  await input.fill("$");
  const menu = page.getByRole("listbox", { name: "MAIN 技能", exact: true });
  await expect(menu.getByRole("option")).toHaveCount(7);
  await expect(menu.getByText("beta-review", { exact: true })).toBeVisible();
  await expect(menu.getByText("external-manual", { exact: true })).toBeVisible();
  for (const name of ["inactive-review", "external-disabled", "external-unadded"]) await expect(menu.getByText(name, { exact: true })).toHaveCount(0);
  const calls = await page.evaluate(() => (window as any).__SKILL_PICKER_E2E__.discoveryCalls.length);
  await input.pressSequentially("review");
  await expect(menu.getByRole("option")).toHaveCount(2);
  expect(await page.evaluate(() => (window as any).__SKILL_PICKER_E2E__.discoveryCalls.length)).toBe(calls);
  await expect(menu.getByRole("option").nth(0)).toHaveAttribute("aria-selected", "true");
  await input.press("ArrowDown");
  await expect(menu.getByRole("option").nth(1)).toHaveAttribute("aria-selected", "true");
  await input.press("ArrowUp");
  await expect(menu.getByRole("option").nth(0)).toHaveAttribute("aria-selected", "true");
  await input.press("ArrowDown");
  await input.press("Enter");
  await expect(input).toHaveValue("$beta-review ");
  await expect(menu).toHaveCount(0);
  await input.fill("Use $external-man");
  await expect(menu.getByRole("option")).toHaveCount(1);
  await input.press("Tab");
  await expect(input).toHaveValue("Use $external-manual ");
  expect(await page.evaluate(() => (window as any).__SKILL_PICKER_E2E__.sends)).toBe(0);
});

test("click selects an exact same-name Skill and Escape leaves the draft unchanged", async ({ page }) => {
  await seedPicker(page);
  const input = page.getByTestId("composer-textarea");
  await input.fill("Please use $same");
  const menu = page.getByTestId("skill-picker-menu");
  await expect(menu.getByRole("option")).toHaveCount(2);
  await menu.locator('[data-skill-id="panel:duplicate-b"]').click();
  await expect(input).toHaveValue(/^Please use \$s:[a-f0-9]{8} /);
  await input.fill("$alpha");
  await expect(menu).toBeVisible();
  await input.press("Escape");
  await expect(menu).toHaveCount(0);
  await expect(input).toHaveValue("$alpha");
  expect(await page.evaluate(() => (window as any).__SKILL_PICKER_E2E__.sends)).toBe(0);
});

test("clicking a Skill cannot replace an active IME composition draft", async ({ page }) => {
  await seedPicker(page);
  const input = page.getByTestId("composer-textarea");
  await input.fill("$alpha");
  const option = page.getByTestId("skill-picker-menu").getByRole("option");
  await expect(option).toHaveCount(1);
  await input.dispatchEvent("compositionstart", { data: "审" });
  await option.click();
  await expect(input).toHaveValue("$alpha");
  await expect(page.getByTestId("skill-picker-menu")).toBeVisible();
  await input.dispatchEvent("compositionend", { data: "审" });
  await option.dispatchEvent("click");
  await expect(input).toHaveValue("$alpha");
  expect(await page.evaluate(() => (window as any).__SKILL_PICKER_E2E__.sends)).toBe(0);
});

test("loading and an empty Skill result intercept Enter and late discovery cannot reopen a dismissed picker", async ({ page }) => {
  await seedPicker(page, "dark", true);
  await page.evaluate(() => { (window as any).__SKILL_PICKER_E2E__.holdWorkspaceA = true; });
  const input = page.getByTestId("composer-textarea");
  await input.fill("$");
  const menu = page.getByTestId("skill-picker-menu");
  await expect(menu.getByRole("status")).toContainText("正在加载");
  await input.press("Enter");
  await expect(input).toHaveValue("$");
  await expect.poll(() => page.evaluate(() => (window as any).__SKILL_PICKER_E2E__.pending.length)).toBeGreaterThan(0);
  await input.press("Escape");
  await page.evaluate(() => {
    const state = (window as any).__SKILL_PICKER_E2E__;
    state.holdWorkspaceA = false;
    state.pending.splice(0).forEach((item: any) => item.release());
  });
  await expect(menu).toHaveCount(0);
  await input.fill("$none");
  await expect(menu.getByRole("status")).toContainText("没有匹配");
  await input.press("Enter");
  await expect(input).toHaveValue("$none");
  await expect(page.getByTestId("user-message-content")).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).__SKILL_PICKER_E2E__.sends)).toBe(0);
});

test("workspace switching fences a late catalog before selecting a new workspace Skill", async ({ page }) => {
  await seedPicker(page);
  await page.evaluate(() => { (window as any).__SKILL_PICKER_E2E__.holdWorkspaceA = true; });
  const input = page.getByTestId("composer-textarea");
  await input.fill("$");
  await expect(page.getByTestId("skill-picker-menu").getByRole("status")).toContainText("正在加载");
  await expect.poll(() => page.evaluate(() => (window as any).__SKILL_PICKER_E2E__.pending.length)).toBeGreaterThan(0);
  await page.getByTestId("sidebar-workspace-row").filter({ hasText: "Picker B" }).click();
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem("local-agent-ide") || "{}").state.currentWorkspace)).toBe(WORKSPACE_B);
  await expect(page.getByTestId("skill-picker-menu")).toHaveCount(0);
  await input.fill("$workspace");
  const menu = page.getByTestId("skill-picker-menu");
  await expect(menu.getByText("workspace-b-only", { exact: true })).toBeVisible();
  await page.evaluate(() => {
    const state = (window as any).__SKILL_PICKER_E2E__;
    state.holdWorkspaceA = false;
    state.pending.splice(0).forEach((item: any) => item.release());
  });
  await expect(menu.getByText("workspace-a-only", { exact: true })).toHaveCount(0);
  await menu.getByRole("option").click();
  await expect(input).toHaveValue("$workspace-b-only ");
});

test("source settings fence an open picker and restore an admitted manual Skill when enabled again", async ({ page }) => {
  await seedPicker(page);
  const input = page.getByTestId("composer-textarea");
  const menu = page.getByTestId("skill-picker-menu");
  await input.fill("$external");
  await expect(menu.getByText("external-manual", { exact: true })).toBeVisible();
  await input.press("Escape");
  await page.evaluate(() => { (window as any).__SKILL_PICKER_E2E__.holdWorkspaceA = true; });
  await input.fill("$external-m");
  await expect(menu.getByRole("status")).toContainText("正在加载");
  await expect.poll(() => page.evaluate(() => (window as any).__SKILL_PICKER_E2E__.pending.length)).toBeGreaterThan(0);
  await page.evaluate(async () => {
    const { useAppStore } = await import("/src/store/useAppStore.ts");
    useAppStore.getState().setExternalSkillSource("claude", false);
  });
  await expect.poll(() => page.evaluate(() => (window as any).__SKILL_PICKER_E2E__.pending.length)).toBeGreaterThan(1);
  await input.press("Enter");
  await expect(input).toHaveValue("$external-m");
  await page.evaluate(() => {
    const state = (window as any).__SKILL_PICKER_E2E__;
    state.holdWorkspaceA = false;
    state.pending.splice(0).forEach((item: any) => item.release());
  });
  await expect(menu.getByRole("status")).toContainText("没有匹配");
  await expect(menu.getByRole("option")).toHaveCount(0);
  await input.press("Enter");
  await expect(input).toHaveValue("$external-m");
  await page.evaluate(async () => {
    const { useAppStore } = await import("/src/store/useAppStore.ts");
    useAppStore.getState().setExternalSkillSource("claude", true);
  });
  await expect(menu.getByText("external-manual", { exact: true })).toBeVisible();
  await menu.getByRole("option").click();
  await expect(input).toHaveValue("$external-manual ");
  expect(await page.evaluate(() => (window as any).__SKILL_PICKER_E2E__.sends)).toBe(0);
});

for (const theme of ["light", "dark", "black"] as const) {
  test(`Skill picker is readable in ${theme} mode`, async ({ page }, testInfo) => {
    await seedPicker(page, theme);
    await page.getByTestId("composer-textarea").fill("$");
    const menu = page.getByTestId("skill-picker-menu");
    await expect(menu.getByRole("option")).toHaveCount(7);
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    await menu.screenshot({ path: testInfo.outputPath(`skill-picker-${theme}.png`), animations: "disabled" });
  });
}
