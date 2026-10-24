import { expect, test } from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";

test("frozen runtime validation keeps its page and store while evidence files change", async ({ page }, testInfo) => {
  test.skip(process.env.MAIN_FROZEN_RUNTIME_E2E !== "1");
  const directory = await fs.mkdtemp(path.resolve("test-results/runtime-watch-"));
  try {
    await page.goto("/?e2eScenario=awaiting-choice");
    const nonce = await page.evaluate(() => ((window as any).__FROZEN_PAGE_NONCE__ = crypto.randomUUID()));
    const navigations: string[] = [];
    page.on("framenavigated", frame => { if (frame === page.mainFrame()) navigations.push(frame.url()); });
    await fs.writeFile(path.join(directory, "index.html"), '<div class="bg-red-500">Owned test evidence</div>');
    await fs.writeFile(path.join(directory, "report.md"), "# Runtime evidence\n\nA diagnostic report changed.\n");
    await page.waitForTimeout(1_000);
    const retained = await page.evaluate(() => (window as any).__FROZEN_PAGE_NONCE__);
    await fs.writeFile(testInfo.outputPath("frozen-page.json"), JSON.stringify({ nonce, retained, navigations }, null, 2));
    expect(navigations).toEqual([]);
    expect(retained).toBe(nonce);
    await expect(page.getByTestId("execution-capsule-awaiting-choice")).toBeVisible();
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});
