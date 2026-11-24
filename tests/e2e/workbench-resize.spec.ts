import { expect, test } from "@playwright/test";
import { installCapsuleFixtureStartup } from "./capsuleFixtureStartup";

test("panel dragging and transient execution updates avoid rewriting workbench preferences", async ({ page }) => {
  await installCapsuleFixtureStartup(page);
  await page.goto("/?e2eScenario=plan-reload-resume");
  await expect(page.getByTestId("plan-review-panel")).toBeVisible();

  const before = await page.evaluate(async () => {
    const source = performance.getEntriesByType("resource").find(entry => new URL(entry.name).pathname === "/src/store/useAppStore.ts")!.name;
    const { useAppStore } = await import(source) as typeof import("/src/store/useAppStore.ts");
    const writes: string[] = [];
    const setItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (this === localStorage && key === "local-agent-ide") writes.push(value);
      setItem.call(this, key, value);
    };
    const updateRuntime = () => {
      for (let index = 0; index < 8; index += 1) {
        useAppStore.setState({ agentMessages: [...useAppStore.getState().agentMessages] });
      }
    };
    Object.assign(window, { workbenchResizeFixture: { writes, store: useAppStore, updateRuntime } });
    return useAppStore.getState().rightPanelWidth;
  });

  const panel = page.getByTestId("right-panel");
  const divider = (await page.getByTestId("right-panel-resizer").boundingBox())!;
  await page.mouse.move(divider.x + divider.width / 2, divider.y + 100);
  await page.mouse.down();
  await page.mouse.move(divider.x - 45, divider.y + 100, { steps: 8 });
  await expect.poll(async () => (await panel.boundingBox())!.width).toBeGreaterThan(before + 25);
  const during = await page.evaluate(() => {
    const { writes, store, updateRuntime } = (window as any).workbenchResizeFixture;
    const beforeUpdates = writes.length;
    updateRuntime();
    return { width: store.getState().rightPanelWidth, runtimeWrites: writes.length - beforeUpdates };
  });
  await page.mouse.up();
  expect.soft(during.width).toBe(before);
  expect.soft(during.runtimeWrites).toBe(0);
  const after = await page.evaluate(initialWidth => {
    const { writes, store } = (window as any).workbenchResizeFixture;
    const widthWrites = writes.filter((value: string) => JSON.parse(value).state?.rightPanelWidth !== initialWidth);
    return { width: store.getState().rightPanelWidth, writes: widthWrites.length,
      persisted: JSON.parse(localStorage.getItem("local-agent-ide") || "{}").state?.rightPanelWidth };
  }, before);
  expect(after.width).toBeGreaterThan(before + 25);
  expect(after.persisted).toBe(after.width);
  expect(after.writes).toBe(1);
});
