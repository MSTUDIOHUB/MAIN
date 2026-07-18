import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    if (!window.sessionStorage.getItem("__CODELY_E2E_STORAGE_RESET__")) {
      window.localStorage.clear();
      window.sessionStorage.setItem("__CODELY_E2E_STORAGE_RESET__", "1");
    }
  });
});

test("read/search progress stays accessible in the continuous process timeline without a ChatArea ledger", async ({ page }) => {
  await page.goto("/?e2eScenario=read-context-interleaved");

  await expect(page.getByTestId("effective-progress-ledger")).toHaveCount(0);
  await expect(page.getByTestId("turn-process-archive-toggle")).toHaveCount(0);
  const processDisclosure = page.getByTestId("turn-process-disclosure");
  await expect(processDisclosure).toContainText("5 个工具");
  await expect(page.getByTestId("progress-block")).toHaveCount(0);
  const processDetails = page.getByTestId("live-turn-process-details");
  await expect(processDetails).toContainText("package.json");
  await expect(processDetails).toContainText("useAppStore.ts");
  await expect(processDetails).toContainText("release*.md");
  await expect(processDetails).toContainText("git status --short --branch");
  await expect(processDetails).toContainText("npm run build -- --mode test");
  await expect(page.getByText("读取与命令交错完成，命令步骤已折叠保留。")).toBeVisible();
});

test("model-claimed stage summary stays out of ChatArea while read/search evidence remains available", async ({ page }) => {
  await page.goto("/?e2eScenario=read-context-agent-segment");

  await expect(page.getByTestId("turn-process-archive-toggle")).toHaveCount(0);
  await expect(page.getByTestId("progress-block")).toHaveCount(0);
  await expect(page.getByTestId("effective-progress-ledger")).toHaveCount(0);
  await expect(page.getByText("第二段读取完成。")).toBeVisible();
  const stageSummary = page.getByText("阶段性结论：第一段读取确认 ChatArea 会把读取记录按正文边界分段。");
  await expect(stageSummary).toHaveCount(0);
  await expect(page.getByText("已确认问题来自执行摘要没有独立的可见性身份")).toBeVisible();
  await expect(page.getByText("下一步将核对 README 中的展示约束")).toBeVisible();

  const processTimeline = page.getByTestId("live-turn-process-timeline");
  await expect(processTimeline).toBeVisible();
  await expect(processTimeline).not.toContainText("阶段性结论：第一段读取确认");
  const processDetails = page.getByTestId("live-turn-process-details");
  await expect(processDetails).toContainText("ChatArea.tsx");
  await expect(processDetails).toContainText("README.md");
});

test("thin read narration becomes transparent while the substantive model explanation stays visible", async ({ page }) => {
  await page.goto("/?e2eScenario=read-context-thin-narration");

  await expect(page.getByText("根据截图观察到的现象：")).toBeVisible();
  await expect(page.getByText("核心问题映射：CSV 数据已加载")).toBeVisible();
  await expect(page.getByText("让我继续读取关键文件来确认问题根因。")).toHaveCount(0);

  const processTimeline = page.getByTestId("live-turn-process-timeline");
  await expect(processTimeline).toBeVisible();
  const details = page.getByTestId("live-turn-process-details");
  await expect(details).toContainText("App.tsx");
  await expect(details).toContainText("OverviewCards.tsx");
  await expect(details).toContainText("CourseBarChart.tsx");
});

test("effective progress stays out of ChatArea after plan card and follow-up messages", async ({ page }) => {
  await page.goto("/?e2eScenario=read-context-persistent-progress");

  const chat = page.getByTestId("chat-scroll-container");
  await expect(chat.getByTestId("effective-progress-ledger")).toHaveCount(0);
  await expect(chat.getByTestId("turn-activity-notice")).toHaveCount(0);
  await expect(chat.getByTestId("turn-process-archive-toggle")).toHaveCount(0);
  await expect(chat.getByTestId("progress-block")).toHaveCount(0);

  await expect(chat.getByText("计划进展保留")).toBeVisible();
  await expect(chat.getByText("后续消息已显示；上一轮工具记录仍保留在折叠上下文分组中。")).toBeVisible();
  await expect(page.getByTestId("execution-capsule")).toHaveCount(0);

  const processToggle = chat.getByTestId("live-turn-process-toggle");
  await expect(processToggle).toBeVisible();
  await expect(processToggle).toHaveAttribute("aria-expanded", "true");
  const processDetails = chat.getByTestId("live-turn-process-details");
  await expect(processDetails).toContainText("dashboardStore.ts");
  await expect(processDetails).toContainText("useCsvParser.ts");
});
