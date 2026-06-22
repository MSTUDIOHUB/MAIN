import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    if (!window.sessionStorage.getItem("__CODELY_E2E_STORAGE_RESET__")) {
      window.localStorage.clear();
      window.sessionStorage.setItem("__CODELY_E2E_STORAGE_RESET__", "1");
    }
  });
});

test("read/search progress stays visible when interleaved with folded command steps", async ({ page }) => {
  await page.goto("/?e2eScenario=read-context-interleaved");

  const ledger = page.getByTestId("turn-activity-notice").first().getByTestId("effective-progress-ledger");
  await expect(ledger).toBeVisible();
  await expect(ledger).toContainText("有效进展");
  await expect(ledger).toContainText("*release*.md");

  await expect(page.getByTestId("turn-process-archive-toggle")).toHaveCount(0);
  await expect(page.getByTestId("progress-block")).toHaveCount(0);
  await expect(page.getByTestId("read-context-group")).toHaveCount(3);
  await expect(page.getByTestId("completed-tool-group")).toHaveCount(2);
  await expect(page.getByTestId("read-context-group").filter({ hasText: "package.json" })).toBeVisible();
  await expect(page.getByTestId("read-context-group").filter({ hasText: "useAppStore.ts" })).toBeVisible();
  await expect(page.getByTestId("read-context-group").filter({ hasText: "*release*.md" })).toBeVisible();
  await expect(page.getByTestId("completed-tool-group").filter({ hasText: "git status --short --branch" })).toBeVisible();
  await expect(page.getByTestId("completed-tool-group").filter({ hasText: "npm run build -- --mode test" })).toBeVisible();
  await expect(page.getByText("读取与命令交错完成，命令步骤已折叠保留。")).toBeVisible();
});

test("visible agent output remains in transcript between folded read/search groups", async ({ page }) => {
  await page.goto("/?e2eScenario=read-context-agent-segment");

  await expect(page.getByTestId("turn-process-archive-toggle")).toHaveCount(0);
  await expect(page.getByTestId("progress-block")).toHaveCount(0);
  await expect(page.getByTestId("turn-activity-notice").first().getByTestId("effective-progress-ledger")).toContainText("README.md");
  await expect(page.getByText("第二段读取完成。")).toBeVisible();

  const groups = page.getByTestId("read-context-group");
  await expect(groups).toHaveCount(2);
  const firstGroup = groups.nth(0);
  const secondGroup = groups.nth(1);
  await expect(firstGroup).toContainText("已读取 2 项上下文");
  await expect(secondGroup).toContainText("已读取 1 项上下文");
  await expect(page.getByText("第一段读取完成，先输出阶段结论。")).toBeVisible();
  await expect
    .poll(async () =>
      page.evaluate(() => {
        const groups = Array.from(document.querySelectorAll('[data-testid="read-context-group"]'));
        const firstAgent = Array.from(document.querySelectorAll(".chat-agent-content"))
          .find((node) => node.textContent?.includes("第一段读取完成"));
        if (groups.length < 2 || !firstAgent) return false;
        const firstGroupTop = groups[0].getBoundingClientRect().top;
        const agentTop = firstAgent.getBoundingClientRect().top;
        const secondGroupTop = groups[1].getBoundingClientRect().top;
        return firstGroupTop < agentTop && agentTop < secondGroupTop;
      }),
    )
    .toBe(true);

  await firstGroup.click();
  let details = page.getByTestId("read-context-group-details");
  await expect(details).toBeVisible();
  await expect(details).toContainText("ChatArea.tsx");
  await expect(page.getByTestId("read-context-item")).toHaveCount(2);
  await firstGroup.click();
  await expect(page.getByTestId("read-context-group-details")).toHaveCount(0);

  await secondGroup.click();
  details = page.getByTestId("read-context-group-details");
  await expect(details).toBeVisible();
  await expect(details).toContainText("README.md");
  await expect(page.getByTestId("read-context-item")).toHaveCount(1);
});

test("thin read narration becomes transparent while the substantive model explanation stays visible", async ({ page }) => {
  await page.goto("/?e2eScenario=read-context-thin-narration");

  await expect(page.getByText("根据截图观察到的现象：")).toBeVisible();
  await expect(page.getByText("核心问题映射：CSV 数据已加载")).toBeVisible();
  await expect(page.getByText("让我继续读取关键文件来确认问题根因。")).toHaveCount(0);

  const groups = page.getByTestId("read-context-group");
  await expect(groups).toHaveCount(1);
  const group = groups.first();
  await expect(group).toContainText("已读取 3 项上下文");
  await expect(group).toContainText("App.tsx");
  await expect(group).toContainText("OverviewCards.tsx");
  await expect(group).toContainText("CourseBarChart.tsx");

  await group.click();
  const details = page.getByTestId("read-context-group-details");
  await expect(details).toBeVisible();
  await expect(page.getByTestId("read-context-item")).toHaveCount(3);
});

test("effective progress stays in ChatArea after plan card and follow-up messages", async ({ page }) => {
  await page.goto("/?e2eScenario=read-context-persistent-progress");

  const chat = page.getByTestId("chat-scroll-container");
  await expect(chat.getByTestId("live-turn-process-toggle")).toHaveCount(0);
  const progressLedger = chat.getByTestId("turn-activity-notice").first().getByTestId("effective-progress-ledger");
  await expect(progressLedger).toBeVisible();
  await expect(progressLedger).toContainText("有效进展");
  await expect(progressLedger).toContainText("plan.md");
  await expect(chat.getByTestId("turn-process-archive-toggle")).toHaveCount(0);
  await expect(chat.getByTestId("progress-block")).toHaveCount(0);
  await progressLedger.getByTestId("effective-progress-ledger-toggle").click();
  await expect(progressLedger.getByTestId("effective-progress-ledger-details")).toContainText("dashboardStore.ts");
  await expect(progressLedger.getByTestId("effective-progress-ledger-details")).toContainText("x2 / 1 cached");

  const readGroup = chat.getByTestId("read-context-group").first();
  await expect(readGroup).toBeVisible();
  await expect(readGroup).toContainText("已读取 2 项有效上下文（共 3 次）");
  await expect(readGroup).toContainText("去重 1 次重复读取");
  await expect(readGroup).toContainText("缓存复用");

  await expect(chat.getByText("我已经生成了可审批计划文件 .MAIN/plans/plan.md，现在停在审批阶段。")).toBeVisible();
  await expect(chat.getByText("后续消息已显示；上一轮有效进展应仍保留在 ChatArea 正文中。")).toBeVisible();
  await expect(page.getByTestId("execution-capsule")).toHaveCount(0);

  await readGroup.click();
  const details = chat.getByTestId("read-context-group-details");
  await expect(details).toBeVisible();
  await expect(details).toContainText("dashboardStore.ts");
  await expect(details).toContainText("x2 / 1 cached");
  await expect(details).toContainText("useCsvParser.ts");
});
