import { expect, test } from "@playwright/test";
import { installCapsuleFixtureStartup } from "./capsuleFixtureStartup";

test.beforeEach(async ({ page }) => {
  await installCapsuleFixtureStartup(page);
});

test("black appearance mode persists and applies the pure black theme", async ({ page }) => {
  await page.goto("/?e2eScenario=process-display");

  await page.getByTestId("model-settings-button").click();
  await page.getByTestId("settings-tab-general").click();
  await page.getByRole("button", { name: "黑色" }).click();

  await expect(page.getByRole("button", { name: "黑色" })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("theme-card-black")).toBeVisible();
  await expect(page.getByTestId("theme-card-light")).toHaveCount(0);
  await expect(page.getByTestId("theme-card-dark")).toHaveCount(0);
  await expect(page.locator("html")).toHaveAttribute("data-theme", "black");

  const fontSizeSlider = page.getByTestId("chat-font-size-slider");
  const fontSizeBadge = page.getByTestId("chat-font-size-badge");
  await expect(fontSizeSlider).toHaveCSS("appearance", "none");
  await expect(fontSizeSlider).toHaveCSS("border-top-style", "none");
  await expect(fontSizeBadge).toHaveCSS("color", "rgb(255, 255, 255)");
  await fontSizeSlider.fill("16");
  await expect(fontSizeBadge).toHaveText("16 px");
  await expect
    .poll(async () =>
      fontSizeSlider.evaluate((el) => getComputedStyle(el).getPropertyValue("--slider-progress").trim()),
    )
    .toBe("60%");
  await expect
    .poll(async () => page.evaluate(() => (window as any).__CODELY_E2E__?.getSnapshot?.().themeMode ?? null))
    .toBe("black");

  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "black");
  await expect
    .poll(async () => page.evaluate(() => (window as any).__CODELY_E2E__?.getSnapshot?.().themeMode ?? null))
    .toBe("black");
});

test("light preset selection updates CSS tokens, supports custom hex editing, and toggles code preview", async ({ page }) => {
  await page.goto("/?e2eScenario=process-display");

  await page.getByTestId("model-settings-button").click();
  await page.getByTestId("settings-tab-general").click();
  await page.getByTestId("theme-mode-light").click();

  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await expect(page.getByTestId("theme-card-light")).toBeVisible();

  await page.getByTestId("theme-preset-select-light").selectOption("catppuccin");

  await expect
    .poll(async () =>
      page.evaluate(() => {
        const styles = getComputedStyle(document.documentElement);
        return {
          surface0: styles.getPropertyValue("--surface-0").trim().toUpperCase(),
          text: styles.getPropertyValue("--surface-text").trim().toUpperCase(),
          accent: styles.getPropertyValue("--accent").trim().toUpperCase(),
        };
      }),
    )
    .toEqual({
      surface0: "#EAECF0",
      text: "#4C4F69",
      accent: "#8839EF",
    });

  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await expect
    .poll(async () =>
      page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--surface-0").trim().toUpperCase()),
    )
    .toBe("#EAECF0");

  await page.getByTestId("model-settings-button").click();
  await page.getByTestId("settings-tab-general").click();
  await expect(page.getByTestId("theme-preset-select-light")).toHaveValue("catppuccin");

  const bgInput = page.getByTestId("theme-color-light-background");
  await bgInput.fill("#F8F5EE");
  await bgInput.blur();

  await expect(page.getByTestId("theme-preset-select-light")).toHaveValue("custom");
  await expect
    .poll(async () =>
      page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--surface-0").trim().toUpperCase()),
    )
    .toBe("#F8F5EE");

  await page.getByTestId("theme-code-preview-toggle-light").click();
  await expect(page.getByTestId("theme-code-preview-panel-light")).toBeVisible();
  await expect(page.getByTestId("theme-code-preview-panel-light")).toContainText("#F8F5EE");

  await page.getByTestId("theme-code-preview-toggle-light").click();
  await expect(page.getByTestId("theme-code-preview-panel-light")).toHaveCount(0);
});

test("system appearance mode follows prefers-color-scheme and displays both light and dark cards", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await page.goto("/?e2eScenario=process-display");

  await page.getByTestId("model-settings-button").click();
  await page.getByTestId("settings-tab-general").click();
  await page.getByTestId("theme-mode-system").click();

  await expect(page.getByTestId("theme-card-light")).toBeVisible();
  await expect(page.getByTestId("theme-card-dark")).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");

  await page.getByTestId("theme-preset-select-dark").selectOption("warm-charcoal");
  await page.getByTestId("theme-preset-select-light").selectOption("warm-paper");

  await expect
    .poll(async () =>
      page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--surface-0").trim().toUpperCase()),
    )
    .toBe("#1C1917");

  await page.emulateMedia({ colorScheme: "light" });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await expect
    .poll(async () =>
      page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--surface-0").trim().toUpperCase()),
    )
    .toBe("#F5F2EB");
});
