import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    if (!window.sessionStorage.getItem("__CODELY_E2E_STORAGE_RESET__")) {
      window.localStorage.clear();
      window.sessionStorage.setItem("__CODELY_E2E_STORAGE_RESET__", "1");
    }
  });
});

test("plan panel refreshes when tasks.md is updated through replace_in_file", async ({ page }) => {
  await page.goto("/?e2eScenario=plan-replace-refresh");

  await expect(page.getByTestId("plan-stage-badge")).toContainText("已暂停");
  await expect(page.getByText("1/3", { exact: true })).toBeVisible();
  await expect(page.getByTestId("markdown-table").locator("table")).toBeVisible();
  await expect(page.getByRole("columnheader", { name: "验证项" })).toBeVisible();
  await expect(page.getByRole("cell", { name: "PlanPanel 表格" })).toBeVisible();
  await expect(page.getByText("保存方案供用户留档（已完成）")).toHaveCount(0);

  await expect
    .poll(async () =>
      page.evaluate(() =>
        ((window as any).__CODELY_E2E__?.getSnapshot?.().planTasks ?? []).map(
          (task: { status: string }) => task.status,
        ),
      ),
    )
    .toEqual(["completed", "in_progress", "pending"]);

  await page.evaluate(() => (window as any).__CODELY_E2E__?.replacePlanTasks?.());

  await expect
    .poll(async () =>
      page.evaluate(() => {
        const event = (window as any).__CODELY_E2E__?.events?.find(
          (item: { type: string }) => item.type === "tasks-replaced",
        );
        if (!event) return null;
        return {
          statuses: event.statuses,
          artifactIncludesCompletedLine: String(event.artifactContent || "").includes("[x] 保存方案供用户留档（已完成）"),
        };
      }),
    )
    .toEqual({
      statuses: ["completed", "completed", "in_progress"],
      artifactIncludesCompletedLine: true,
    });

  await expect(page.getByText("2/3", { exact: true })).toBeVisible();
  await expect(page.getByText("保存方案供用户留档（已完成）").first()).toBeVisible();
});

test("plan panel markdown tables stay visible across light dark and black themes", async ({ page }) => {
  await page.goto("/?e2eScenario=plan-replace-refresh");

  for (const theme of ["light", "dark", "black"]) {
    await page.evaluate((nextTheme) => (window as any).__CODELY_E2E__?.setThemeMode?.(nextTheme), theme);
    await expect
      .poll(async () => page.evaluate(() => document.documentElement.getAttribute("data-theme")))
      .toBe(theme);

    const table = page.getByTestId("markdown-table");
    await expect(table.locator("table")).toBeVisible();
    await expect(page.getByRole("columnheader", { name: "验证项" })).toBeVisible();
    await expect(page.getByRole("cell", { name: "PlanPanel 表格" })).toBeVisible();

    const colors = await table.evaluate((element) => {
      const cell = element.querySelector("td");
      const header = element.querySelector("th");
      const wrapperStyle = window.getComputedStyle(element);
      const cellStyle = cell ? window.getComputedStyle(cell) : null;
      const headerStyle = header ? window.getComputedStyle(header) : null;
      return {
        wrapperBorder: wrapperStyle.borderTopColor,
        wrapperBg: wrapperStyle.backgroundColor,
        cellColor: cellStyle?.color || "",
        headerColor: headerStyle?.color || "",
        scrollsHorizontally: element.scrollWidth >= element.clientWidth,
      };
    });

    expect(colors.wrapperBorder).not.toBe("rgba(0, 0, 0, 0)");
    expect(colors.wrapperBg).not.toBe("rgba(0, 0, 0, 0)");
    expect(colors.cellColor).not.toBe("");
    expect(colors.headerColor).not.toBe("");
  }
});
