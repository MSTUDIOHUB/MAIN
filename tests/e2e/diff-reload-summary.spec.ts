import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    if (!window.sessionStorage.getItem("__CODELY_E2E_STORAGE_RESET__")) {
      window.localStorage.clear();
      window.sessionStorage.setItem("__CODELY_E2E_STORAGE_RESET__", "1");
    }

    const workspace = "/tmp/e2e-diff-reload";
    const resolvePath = (path: unknown) => {
      const raw = String(path ?? "");
      if (raw.startsWith("/")) return raw;
      return `${workspace}/${raw.replace(/^\/+/, "")}`;
    };
    const files: Record<string, string> = {
      [`${workspace}/src/main.ts`]: [
        "export function main() {",
        "  const title = 'new main';",
        "  return title;",
        "}",
      ].join("\n"),
      [`${workspace}/src/utils/helper.ts`]: [
        "export const helper = () => 'after';",
        "export const status = 'ready';",
      ].join("\n"),
      [`${workspace}/src/generated.ts`]: "export const generated = true;\n",
    };
    const calls: Array<{ cmd: string; args?: Record<string, unknown> }> = [];

    (window as any).__DIFF_REVERT_TEST__ = {
      files,
      calls,
      read(path: string) {
        return files[resolvePath(path)];
      },
      has(path: string) {
        return Object.prototype.hasOwnProperty.call(files, resolvePath(path));
      },
      set(path: string, content: string) {
        files[resolvePath(path)] = content;
      },
    };

    (window as any).__TAURI_EVENT_PLUGIN_INTERNALS__ ??= {
      unregisterListener: () => {},
    };
    let callbackId = 1;
    const callbacks = new Map<number, unknown>();
    const internals = ((window as any).__TAURI_INTERNALS__ ??= {});
    internals.transformCallback = (callback: unknown) => {
      const id = callbackId++;
      callbacks.set(id, callback);
      return id;
    };
    internals.unregisterCallback = (id: number) => {
      callbacks.delete(Number(id));
    };
    internals.metadata ??= {
      currentWindow: { label: "main" },
      currentWebview: { label: "main" },
    };
    internals.invoke = async (cmd: string, args?: Record<string, unknown>) => {
      calls.push({ cmd, args });
      if (cmd === "plugin:event|listen") return Number(args?.handler ?? callbackId++);
      if (cmd === "plugin:event|unlisten") return null;
      if (cmd === "get_system_memory") return { total_gb: 32, available_gb: 24 };
      if (cmd === "get_workspace_root") return workspace;
      if (cmd === "set_workspace_root" || cmd === "canonicalize_workspace_path") return String(args?.path ?? workspace);
      if (cmd === "list_project_sessions" || cmd === "rebuild_project_sessions_index") return [];
      if (cmd === "save_project_session") return args?.session ?? {};
      if (cmd === "load_project_session") return {};
      if (cmd === "get_file_metadata") {
        const path = resolvePath(args?.path);
        if (!Object.prototype.hasOwnProperty.call(files, path)) throw new Error(`ENOENT: ${path}`);
        return { path, sizeBytes: files[path].length, modifiedMs: 1 };
      }
      if (cmd === "read_file") {
        const path = resolvePath(args?.path);
        if (!Object.prototype.hasOwnProperty.call(files, path)) throw new Error(`ENOENT: ${path}`);
        return files[path];
      }
      if (cmd === "write_file") {
        files[resolvePath(args?.path)] = String(args?.content ?? "");
        return null;
      }
      if (cmd === "delete_workspace_path") {
        delete files[resolvePath(args?.path)];
        return null;
      }
      if (cmd === "list_directory") return [];
      if (cmd === "get_pty_status") {
        return {
          active: false,
          running: false,
          pid: null,
          exitCode: 0,
          bufferStartOffset: 0,
          bufferEndOffset: 0,
          bufferBytes: 0,
          tail: "",
        };
      }
      if (cmd === "spawn_pty" || cmd === "read_pty_buffer" || cmd === "resize_pty") return null;
      return null;
    };
  });
});

test("diff summary stays folded by default and remains clickable after reload", async ({ page }) => {
  await page.goto("/?e2eScenario=diff-reload-summary");

  await expect(page.getByText("3 个变更文件")).toBeVisible();
  await expect(page.getByTestId("turn-changes-toggle")).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByTestId("turn-change-entry")).toHaveCount(0);
  await expect(page.getByTestId("turn-process-archive-toggle")).toBeVisible();
  await expect(page.getByText("已编辑")).toHaveCount(0);
  await expect(page.getByText("npm test -- --runInBand")).toHaveCount(0);
  await expect(page.getByText("已完成三个文件的修改，你可以在摘要卡中查看每个文件的 Diff。")).toBeVisible();
  await expect
    .poll(async () =>
      page.evaluate(() => {
        const archive = document.querySelector('[data-testid="turn-process-archive-toggle"]');
        const conclusion = Array.from(document.querySelectorAll(".chat-agent-content"))
          .find((node) => node.textContent?.includes("已完成三个文件的修改"));
        if (!archive || !conclusion) return false;
        return archive.getBoundingClientRect().top < conclusion.getBoundingClientRect().top;
      }),
    )
    .toBe(true);

  await page.getByTestId("turn-changes-toggle").click();
  await expect(page.getByTestId("turn-change-entry").filter({ hasText: "main.ts" })).toBeVisible();
  await expect(page.getByTestId("turn-change-entry").filter({ hasText: "helper.ts" })).toBeVisible();
  await expect(page.getByTestId("turn-change-entry").filter({ hasText: "generated.ts" })).toBeVisible();

  await page.getByTestId("turn-change-entry").filter({ hasText: "main.ts" }).click();
  await expect(page.getByTestId("diff-panel-title")).toContainText("src/main.ts");

  await page.getByTestId("turn-process-archive-toggle").click();
  await expect(page.getByTestId("turn-process-archive-details")).toBeVisible();
  await expect(page.getByText("npm test -- --runInBand")).toBeVisible();

  await expect
    .poll(async () =>
      page.evaluate(() => ({
        showDiff: Boolean((window as any).__CODELY_E2E__?.getSnapshot?.().showDiff),
        selectedDiffTaskId: (window as any).__CODELY_E2E__?.getSnapshot?.().selectedDiffTaskId ?? null,
      })),
    )
    .toMatchObject({
      showDiff: true,
    });
  await expect
    .poll(async () =>
      page.evaluate(() => (window as any).__CODELY_E2E__?.getSnapshot?.().selectedDiffTaskId ?? null),
    )
    .not.toBeNull();

  await page.reload();

  await expect(page.getByText("3 个变更文件")).toBeVisible();
  await expect(page.getByTestId("turn-changes-toggle")).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByTestId("turn-change-entry")).toHaveCount(0);

  await page.getByTestId("turn-changes-toggle").click();
  await page.getByTestId("turn-change-entry").filter({ hasText: "main.ts" }).click();
  await expect(page.getByTestId("diff-panel-title")).toContainText("src/main.ts");

  await page.getByTestId("turn-change-entry").filter({ hasText: "helper.ts" }).click();
  await expect(page.getByTestId("diff-panel-title")).toContainText("src/utils/helper.ts");
});

test("diff panel reverts one file with confirmation and updates the summary", async ({ page }) => {
  await page.goto("/?e2eScenario=diff-reload-summary");

  await page.getByTestId("turn-changes-toggle").click();
  await page.getByTestId("turn-change-entry").filter({ hasText: "main.ts" }).click();
  await expect(page.getByTestId("diff-panel-title")).toContainText("src/main.ts");

  page.once("dialog", async (dialog) => {
    expect(dialog.message()).toContain("src/main.ts");
    await dialog.accept();
  });
  await page.locator('[data-testid="diff-revert-file"][data-diff-path="src/main.ts"]').click();

  await expect(page.locator('[data-testid="diff-revert-status"]').filter({ hasText: "已撤销" })).toBeVisible();
  await expect
    .poll(async () => page.evaluate(() => (window as any).__DIFF_REVERT_TEST__.read("src/main.ts")))
    .toBe([
      "export function main() {",
      "  return 'old main';",
      "}",
    ].join("\n"));
  await expect(page.getByText("2 个变更文件")).toBeVisible();
  await expect(page.getByTestId("turn-change-entry").filter({ hasText: "main.ts" })).toHaveCount(0);
});

test("diff panel reverts all files and deletes files created by the AI", async ({ page }) => {
  await page.goto("/?e2eScenario=diff-reload-summary");

  await page.getByTestId("turn-changes-toggle").click();
  await page.getByTestId("turn-change-entry").filter({ hasText: "helper.ts" }).click();
  await expect(page.getByTestId("diff-panel-title")).toContainText("src/utils/helper.ts");

  page.once("dialog", async (dialog) => {
    expect(dialog.message()).toContain("3 个文件");
    await dialog.accept();
  });
  await page.getByTestId("diff-revert-all").click();

  await expect
    .poll(async () => page.evaluate(() => (window as any).__DIFF_REVERT_TEST__.read("src/main.ts")))
    .toBe([
      "export function main() {",
      "  return 'old main';",
      "}",
    ].join("\n"));
  await expect
    .poll(async () => page.evaluate(() => (window as any).__DIFF_REVERT_TEST__.read("src/utils/helper.ts")))
    .toBe([
      "export const helper = () => 'before';",
      "export const status = 'draft';",
    ].join("\n"));
  await expect
    .poll(async () => page.evaluate(() => (window as any).__DIFF_REVERT_TEST__.has("src/generated.ts")))
    .toBe(false);
  await expect(page.getByTestId("turn-change-entry")).toHaveCount(0);
});

test("diff revert refuses to overwrite later user edits", async ({ page }) => {
  await page.goto("/?e2eScenario=diff-reload-summary");

  await page.getByTestId("turn-changes-toggle").click();
  await page.getByTestId("turn-change-entry").filter({ hasText: "helper.ts" }).click();
  await page.evaluate(() => {
    (window as any).__DIFF_REVERT_TEST__.set("src/utils/helper.ts", "manual edit\n");
  });

  page.once("dialog", async (dialog) => {
    await dialog.accept();
  });
  await page.locator('[data-testid="diff-revert-file"][data-diff-path="src/utils/helper.ts"]').click();

  await expect(page.locator('[data-testid="diff-revert-status"]').filter({ hasText: "撤销失败" })).toBeVisible();
  await expect(page.getByText("文件内容已经变化，未覆盖后续改动。")).toBeVisible();
  await expect
    .poll(async () => page.evaluate(() => (window as any).__DIFF_REVERT_TEST__.read("src/utils/helper.ts")))
    .toBe("manual edit\n");
});
