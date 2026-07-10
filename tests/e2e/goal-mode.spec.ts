import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    if (!window.sessionStorage.getItem("__CODELY_E2E_STORAGE_RESET__")) {
      window.localStorage.clear();
      window.sessionStorage.setItem("__CODELY_E2E_STORAGE_RESET__", "1");
    }
  });
});

test("Goal capsule exposes one themed popover with persistent lifecycle controls", async ({ page }) => {
  await page.goto("/?e2eScenario=goal-capsule");

  const trigger = page.getByTestId("goal-capsule-trigger");
  await expect(trigger).toBeVisible();
  await expect(trigger).toHaveAttribute("data-goal-status", "active");

  await trigger.click();
  const panel = page.getByTestId("goal-popover-panel");
  await expect(panel).toBeVisible();
  await expect(panel).toContainText("持续目标");
  await expect(panel).toContainText("验证 Capsule Goal 菜单与三主题");
  await expect(panel).toContainText("npm run lint");
  await expect(page.getByTestId("effective-progress-popover")).toHaveCount(0);
  await expect(page.getByTestId("tasks-progress-popover")).toHaveCount(0);

  await page.evaluate(() => (window as any).__CODELY_E2E__?.setTheme?.("green"));
  for (const mode of ["dark", "black", "light"] as const) {
    await page.evaluate((themeMode) => (window as any).__CODELY_E2E__?.setThemeMode?.(themeMode), mode);
    await expect(page.locator("html")).toHaveAttribute("data-theme", mode);
    await expect(panel).toBeVisible();
    await expect.poll(async () => page.evaluate((themeMode) => {
      const root = getComputedStyle(document.documentElement);
      const button = document.querySelector<HTMLElement>("[data-testid='goal-capsule-trigger']");
      const accent = root.getPropertyValue("--accent-light").trim();
      const probe = document.createElement("span");
      probe.style.color = accent;
      document.body.appendChild(probe);
      const normalizedAccent = getComputedStyle(probe).color;
      probe.remove();
      if (!button) return false;
      const triggerColor = getComputedStyle(button).color;
      if (themeMode !== "light") return triggerColor === normalizedAccent;
      const channels = triggerColor.match(/\d+(?:\.\d+)?/g)?.map(Number) || [];
      return channels.length >= 3 && channels[1] > channels[0] && channels[1] > channels[2];
    }, mode)).toBe(true);

    const colors = await page.evaluate(() => {
      const root = getComputedStyle(document.documentElement);
      const button = document.querySelector<HTMLElement>("[data-testid='goal-capsule-trigger']");
      const popover = document.querySelector<HTMLElement>("[data-testid='goal-popover-panel']");
      const accent = root.getPropertyValue("--accent-light").trim();
      const probe = document.createElement("span");
      probe.style.color = accent;
      document.body.appendChild(probe);
      const normalizedAccent = getComputedStyle(probe).color;
      probe.remove();
      return {
        accent: normalizedAccent,
        trigger: button ? getComputedStyle(button).color : "",
        background: popover ? getComputedStyle(popover).backgroundColor : "",
        foreground: popover ? getComputedStyle(popover).color : "",
      };
    });

    if (mode !== "light") expect(colors.trigger).toBe(colors.accent);
    else expect(colors.trigger).not.toBe("rgb(168, 85, 247)");
    expect(colors.background).not.toBe("rgba(0, 0, 0, 0)");
    expect(colors.foreground).not.toBe(colors.background);
  }

  await page.getByTestId("goal-pause-button").click();
  await expect.poll(async () => page.evaluate(() => (window as any).__CODELY_E2E__?.getSnapshot?.().goalStatus)).toBe("paused");
  await expect(trigger).toHaveAttribute("data-goal-status", "paused");
  await expect(page.getByTestId("goal-resume-button")).toBeVisible();

  await page.getByTestId("goal-edit-button").click();
  const editor = page.getByTestId("goal-objective-editor");
  await expect(editor).toBeVisible();
  await editor.fill("完成 Goal Runtime、Loop Engineering 与三主题 Capsule 验证");
  await page.getByRole("button", { name: "保存目标" }).click();
  await expect.poll(async () => page.evaluate(() => (window as any).__CODELY_E2E__?.getSnapshot?.().activeGoalRevision)).toBe(2);
  await expect.poll(async () => page.evaluate(() => (window as any).__CODELY_E2E__?.getSnapshot?.().goalStatus)).toBe("paused");
  await expect(panel).toContainText("完成 Goal Runtime、Loop Engineering 与三主题 Capsule 验证");

  await page.evaluate(() => (window as any).__CODELY_E2E__?.setGoalStatus?.("completed"));
  await expect(trigger).toHaveAttribute("data-goal-status", "completed");
  await expect(panel).toContainText("已完成");
  await expect(page.getByTestId("goal-resume-button")).toHaveCount(0);
  await expect(trigger).toBeVisible();

  await page.getByTestId("goal-clear-button").click();
  await expect(page.getByTestId("goal-clear-confirm")).toContainText("不会回滚文件修改");
  await page.getByRole("button", { name: "确认清除" }).click();
  await expect(trigger).toHaveCount(0);
  await expect.poll(async () => page.evaluate(() => (window as any).__CODELY_E2E__?.getSnapshot?.().activeGoalId)).toBeNull();
});
