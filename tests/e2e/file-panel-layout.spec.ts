import { expect, test } from "@playwright/test";

test.use({ viewport: { width: 1500, height: 900 } });

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.clear();

    let callbackId = 1;
    const callbacks = new Map<number, unknown>();
    const eventListeners = new Map<number, { event: string; handlerId: number }>();
    const workspace = "/tmp/e2e-diff-reload";
    const rootNodes: Array<{ name: string; path: string; is_dir: boolean }> = [
      { name: "src", path: `${workspace}/src`, is_dir: true },
      { name: "README.md", path: `${workspace}/README.md`, is_dir: false },
    ];
    const childNodes: Record<string, Array<{ name: string; path: string; is_dir: boolean }>> = {
      [`${workspace}/src`]: [
        { name: "main.ts", path: `${workspace}/src/main.ts`, is_dir: false },
        { name: "utils", path: `${workspace}/src/utils`, is_dir: true },
      ],
      [`${workspace}/src/utils`]: [
        { name: "helper.ts", path: `${workspace}/src/utils/helper.ts`, is_dir: false },
      ],
    };
    const files: Record<string, string> = {
      [`${workspace}/README.md`]: "# README\n\nInitial workspace note.\n",
      [`${workspace}/src/main.ts`]: "export function main() {\n  return 'new main';\n}\n",
      [`${workspace}/src/utils/helper.ts`]: "export const helper = () => 'after';\n",
    };

    const sortNodes = (nodes: Array<{ name: string; path: string; is_dir: boolean }>) =>
      nodes.sort((a, b) => {
        if (a.is_dir && !b.is_dir) return -1;
        if (!a.is_dir && b.is_dir) return 1;
        return a.name.localeCompare(b.name);
      });

    const removeNode = (path: string) => {
      for (const nodes of [rootNodes, ...Object.values(childNodes)]) {
        const index = nodes.findIndex((node) => node.path === path);
        if (index >= 0) nodes.splice(index, 1);
      }
    };

    (window as any).__FILE_PANEL_TEST__ = {
      addRootFile(name: string, content = "generated\n") {
        const path = `${workspace}/${name}`;
        files[path] = content;
        if (!rootNodes.some((node) => node.path === path)) {
          rootNodes.push({ name, path, is_dir: false });
          sortNodes(rootNodes);
        }
        return path;
      },
      removePath(path: string) {
        delete files[path];
        removeNode(path);
      },
      pathFor(name: string) {
        return `${workspace}/${name}`;
      },
    };

    (window as any).__TAURI_EVENT_PLUGIN_INTERNALS__ ??= {
      unregisterListener: () => {},
    };

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
      if (cmd === "plugin:event|listen") {
        const handlerId = Number(args?.handler ?? callbackId++);
        eventListeners.set(handlerId, {
          event: String(args?.event ?? ""),
          handlerId,
        });
        return handlerId;
      }
      if (cmd === "plugin:event|unlisten") {
        eventListeners.delete(Number(args?.eventId ?? args?.handler));
        return null;
      }
      if (cmd === "get_system_memory") return { total_gb: 32, available_gb: 24 };
      if (cmd === "get_workspace_root") return workspace;
      if (cmd === "set_workspace_root" || cmd === "canonicalize_workspace_path") return String(args?.path ?? workspace);
      if (cmd === "list_project_sessions" || cmd === "rebuild_project_sessions_index") return [];
      if (cmd === "save_project_session") return args?.session ?? {};
      if (cmd === "load_project_session") return {};
      if (cmd === "list_directory") {
        const path = String(args?.path ?? workspace);
        if (path === workspace) return [...rootNodes];
        return [...(childNodes[path] || [])];
      }
      if (cmd === "read_file") {
        const path = String(args?.path ?? "");
        if (Object.prototype.hasOwnProperty.call(files, path)) return files[path];
        throw new Error(`ENOENT: ${path}`);
      }
      if (cmd === "read_file_window") {
        const path = String(args?.path ?? "");
        if (!Object.prototype.hasOwnProperty.call(files, path)) throw new Error(`ENOENT: ${path}`);
        const content = files[path];
        const lines = content.split(/\r?\n/);
        if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
        const startLine = Math.max(1, Number(args?.startLine ?? 1) || 1);
        const maxLines = Math.max(1, Number(args?.maxLines ?? 240) || 240);
        const endLine = Math.min(lines.length, startLine + maxLines - 1);
        const windowContent = lines.slice(startLine - 1, endLine).join("\n");
        return {
          path,
          content: windowContent,
          startLine,
          endLine,
          totalLines: lines.length,
          totalChars: content.length,
          returnedChars: windowContent.length,
          truncated: endLine < lines.length,
          nextStartLine: endLine < lines.length ? endLine + 1 : null,
        };
      }
      if (cmd === "get_pty_status") {
        return {
          active: true,
          running: true,
          pid: 4242,
          exitCode: null,
          bufferStartOffset: 0,
          bufferEndOffset: 0,
          bufferBytes: 0,
          tail: "",
        };
      }
      if (cmd === "spawn_pty" || cmd === "resize_pty" || cmd === "write_pty") return null;
      if (cmd === "read_pty_buffer") return "";
      return null;
    };
  });
});

test("large file viewer renders a bounded window and loads the next window on demand", async ({ page }) => {
  await page.goto("/?e2eScenario=diff-reload-summary");
  await page.locator('button[aria-label="文件"]').click();
  await page.evaluate(() => (window as any).__FILE_PANEL_TEST__.addRootFile(
    "huge.log",
    Array.from({ length: 520 }, (_, index) => `line ${index + 1}`).join("\n"),
  ));
  await page.getByRole("button", { name: /huge\.log/ }).click();

  await expect(page.getByText(/当前窗口：第 1-240 行 \/ 共 520 行/)).toBeVisible();
  await expect(page.getByText("line 240")).toBeVisible();
  await expect(page.getByText("line 241")).toHaveCount(0);

  await page.getByRole("button", { name: "加载下一段" }).click();
  await expect(page.getByText(/当前窗口：第 1-480 行 \/ 共 520 行/)).toBeVisible();
  await expect(page.getByText("line 241")).toBeVisible();
});

test("file panel stays open beside terminal", async ({ page }) => {
  await page.goto("/?e2eScenario=diff-reload-summary");

  await page.locator('button[aria-label="文件"]').click();
  await expect(page.getByTestId("file-panel")).toBeVisible();
  await expect(page.getByText("README.md")).toBeVisible();

  await page.locator('button[aria-label="集成终端"]').click();
  await expect(page.getByTestId("file-panel")).toBeVisible();
  await expect(page.getByTestId("integrated-terminal")).toBeVisible();

  const fileBox = await page.getByTestId("file-panel").boundingBox();
  const terminalBox = await page.getByTestId("integrated-terminal").boundingBox();
  expect(fileBox).not.toBeNull();
  expect(terminalBox).not.toBeNull();
  expect(fileBox!.x).toBeLessThan(terminalBox!.x);
});

test("file panel stays between chat and diff panel", async ({ page }) => {
  await page.goto("/?e2eScenario=diff-reload-summary");

  await page.locator('button[aria-label="文件"]').click();
  await page.locator('button[aria-label="变更比对"]').click();

  await expect(page.getByTestId("file-panel")).toBeVisible();
  await expect(page.getByTestId("diff-panel")).toBeVisible();

  const fileBox = await page.getByTestId("file-panel").boundingBox();
  const diffBox = await page.getByTestId("diff-panel").boundingBox();
  expect(fileBox).not.toBeNull();
  expect(diffBox).not.toBeNull();
  expect(fileBox!.x + fileBox!.width).toBeLessThanOrEqual(diffBox!.x + 2);
});

test("file tree refreshes automatically after files are created and deleted", async ({ page }) => {
  await page.goto("/?e2eScenario=diff-reload-summary");
  await page.locator('button[aria-label="文件"]').click();

  await expect(page.getByText("generated-notes.md")).toHaveCount(0);
  const generatedPath = await page.evaluate(() => (window as any).__FILE_PANEL_TEST__.addRootFile("generated-notes.md", "# Generated\n"));
  await expect(page.getByText("generated-notes.md")).toBeVisible({ timeout: 5000 });

  await page.evaluate((path) => (window as any).__FILE_PANEL_TEST__.removePath(path), generatedPath);
  await expect(page.getByText("generated-notes.md")).toHaveCount(0, { timeout: 5000 });
});

test("selected deleted file shows an error and can return to tree", async ({ page }) => {
  await page.goto("/?e2eScenario=diff-reload-summary");
  await page.locator('button[aria-label="文件"]').click();
  await page.getByRole("button", { name: /README\.md/ }).click();

  await expect(page.getByText("Initial workspace note.")).toBeVisible();
  const readmePath = await page.evaluate(() => (window as any).__FILE_PANEL_TEST__.pathFor("README.md"));
  await page.evaluate((path) => (window as any).__FILE_PANEL_TEST__.removePath(path), readmePath);

  await expect(page.getByText(/ENOENT: .*README\.md/)).toBeVisible({ timeout: 5000 });
  await page.getByRole("button", { name: "返回" }).click();
  await expect(page.getByText("README.md")).toHaveCount(0);
  await expect(page.getByTestId("file-panel").getByRole("button", { name: "src" })).toBeVisible();
});
