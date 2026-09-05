import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    if (!window.sessionStorage.getItem("__CODELY_E2E_STORAGE_RESET__")) {
      window.localStorage.clear();
      window.sessionStorage.setItem("__CODELY_E2E_STORAGE_RESET__", "1");
    }
  });
});

test("composer help opens the MAIN guide without submitting a turn", async ({ page }) => {
  await page.goto("/?e2eScenario=composer-main-shortcuts");

  const helpButton = page.getByTestId("composer-help-button");
  await expect(helpButton).toBeVisible();
  await expect(helpButton).toHaveAttribute("aria-expanded", "false");

  await helpButton.click();

  const guide = page.getByTestId("main-onboarding-panel");
  const dismissButton = page.getByTestId("main-onboarding-dismiss");
  await expect(guide).toBeVisible();
  await expect(helpButton).toHaveAttribute("aria-expanded", "true");
  await expect(dismissButton).toBeFocused();
  await expect(guide).toContainText("MAIN 使用指南");
  await expect(guide).toContainText("斜杠命令");
  await expect(guide).toContainText("/init");
  await expect(guide).toContainText("/init --refresh");
  await expect(guide).toContainText("@ 引用文件");
  await expect(guide).toContainText("自动审查");

  await expect.poll(async () =>
    page.evaluate(() => (window as any).__CODELY_E2E__?.getSnapshot?.().currentTurnPrompt ?? null),
  ).toBe(null);

  await page.keyboard.press("Escape");
  await expect(guide).toBeHidden();
  await expect(helpButton).toHaveAttribute("aria-expanded", "false");
  await expect(helpButton).toBeFocused();

  await helpButton.click();
  await page.getByTestId("main-onboarding-open-slash").click();
  await expect(guide).toBeHidden();
  await expect(page.getByText("MAIN 快捷入口").first()).toBeVisible();
  await expect(page.getByTestId("main-shortcut-item-plan")).toBeVisible();
  const textarea = page.getByTestId("composer-textarea");
  await expect(textarea).toHaveAttribute("aria-expanded", "true");
  await expect(textarea).toHaveAttribute("aria-controls", "main-slash-command-menu");
  await expect(page.getByRole("listbox", { name: "MAIN 斜杠命令" })).toBeVisible();
  await expect(page.getByTestId("main-shortcut-item-plan")).toHaveAttribute("role", "option");
});

for (const theme of ["light", "dark", "black"] as const) {
  test(`MAIN guide remains readable in ${theme} theme`, async ({ page }, testInfo) => {
    await page.goto("/?e2eScenario=composer-main-shortcuts");
    await page.evaluate((nextTheme) => {
      (window as any).__CODELY_E2E__?.setThemeMode?.(nextTheme);
    }, theme);
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);

    await page.getByTestId("composer-help-button").click();
    const guide = page.getByTestId("main-onboarding-panel");
    await expect(guide).toBeVisible();
    await expect(guide).toHaveAttribute("data-theme-mode", theme);

    const contrast = await guide.evaluate((node) => {
      const card = node.querySelector("[data-guide-card]") as HTMLElement | null;
      const cardTitle = node.querySelector("[data-guide-card-title]") as HTMLElement | null;
      const rgb = (value: string) => (value.match(/[\d.]+/g) || [])
        .slice(0, 3)
        .map(Number);
      const luminance = (channels: number[]) => {
        const linear = channels.map((channel) => {
          const normalized = channel / 255;
          return normalized <= 0.03928
            ? normalized / 12.92
            : ((normalized + 0.055) / 1.055) ** 2.4;
        });
        return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
      };
      const foreground = cardTitle ? rgb(getComputedStyle(cardTitle).color) : [];
      const background = card ? rgb(getComputedStyle(card).backgroundColor) : [];
      const foregroundLuminance = foreground.length === 3 ? luminance(foreground) : 0;
      const backgroundLuminance = background.length === 3 ? luminance(background) : 0;
      return {
        cardBackground: card ? getComputedStyle(card).backgroundColor : "",
        cardTitleColor: cardTitle ? getComputedStyle(cardTitle).color : "",
        contrastRatio:
          (Math.max(foregroundLuminance, backgroundLuminance) + 0.05) /
          (Math.min(foregroundLuminance, backgroundLuminance) + 0.05),
      };
    });
    expect(contrast.cardBackground).not.toBe("");
    expect(contrast.cardTitleColor).not.toBe("");
    expect(contrast.contrastRatio).toBeGreaterThanOrEqual(7);
    await guide.screenshot({ path: testInfo.outputPath(`main-guide-${theme}.png`) });
  });
}
