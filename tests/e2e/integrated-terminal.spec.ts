import { expect, test } from "@playwright/test";

test.use({ viewport: { width: 1440, height: 900 } });

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    if (!window.sessionStorage.getItem("__CODELY_E2E_STORAGE_RESET__")) {
      window.localStorage.clear();
      window.sessionStorage.setItem("__CODELY_E2E_STORAGE_RESET__", "1");
    }

    let callbackId = 1;
    const callbacks = new Map<number, unknown>();
    const eventListeners = new Map<number, { event: string; handlerId: number }>();
    let ptyActive = false;
    let ptyRunning = false;
    let enterCount = 0;
    const writes: string[] = [];
    const spawns: unknown[] = [];
    const terminalOutput: string[] = [];

    const sanitizeSessionKey = (value: unknown) => {
      const raw = String(value || "").trim() || "__MAIN_DEFAULT_PTY__";
      const sanitized = Array.from(raw)
        .map((ch) => /[A-Za-z0-9_.-]/.test(ch) ? ch : "_")
        .join("");
      return sanitized.replace(/^_+|_+$/g, "") || "session";
    };

    const emitTauriEvent = (event: string, payload: unknown) => {
      for (const listener of eventListeners.values()) {
        if (listener.event !== event) continue;
        const callback = callbacks.get(listener.handlerId);
        if (typeof callback === "function") {
          callback({ event, id: listener.handlerId, payload });
        }
      }
    };

    (window as any).__PTY_TEST__ = {
      writes,
      spawns,
      terminalOutput,
      get enterCount() {
        return enterCount;
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
      if (cmd === "get_workspace_root") return "/tmp/e2e-session-auto-create";
      if (cmd === "set_workspace_root") return String(args?.path ?? "");
      if (cmd === "list_project_sessions" || cmd === "rebuild_project_sessions_index") return [];
      if (cmd === "save_project_session") return args?.session ?? {};
      if (cmd === "load_project_session") return {};

      if (cmd === "get_pty_status") {
        return {
          active: ptyActive,
          running: ptyRunning,
          pid: ptyActive ? 4242 : null,
          exitCode: ptyRunning ? null : 0,
          bufferStartOffset: 0,
          bufferEndOffset: writes.join("").length,
          bufferBytes: 0,
          tail: "",
        };
      }
      if (cmd === "spawn_pty") {
        ptyActive = true;
        ptyRunning = true;
        spawns.push(args);
        return null;
      }
      if (cmd === "read_pty_buffer") return "";
      if (cmd === "resize_pty") return null;
      if (cmd === "write_pty") {
        if (!ptyActive || !ptyRunning) {
          throw new Error("PTY is not running");
        }
        const input = String(args?.input ?? "");
        writes.push(input);
        terminalOutput.push(input);
        emitTauriEvent("pty-data", {
          sessionKey: sanitizeSessionKey(args?.sessionKey),
          chunk: input,
        });
        if (input.includes("\r") || input.includes("\n")) {
          enterCount += 1;
          if (enterCount === 1) {
            ptyActive = false;
            ptyRunning = false;
          }
        }
        return null;
      }
      return null;
    };
  });
});

test("terminal keeps accepting input after the first command and respawns a dead PTY", async ({ page }) => {
  await page.goto("/?e2eScenario=session-auto-create");

  await page.getByRole("button", { name: "集成终端" }).click();
  const terminal = page.getByTestId("integrated-terminal");
  await expect(terminal).toBeVisible();

  await terminal.click();
  await expect
    .poll(async () =>
      page.evaluate(() => document.activeElement?.classList.contains("xterm-helper-textarea") ?? false),
    )
    .toBe(true);

  await page.keyboard.type("echo one");
  await expect
    .poll(async () =>
      page.evaluate(() => document.querySelector('[data-testid="integrated-terminal"]')?.textContent ?? ""),
    )
    .toContain("echo one");
  await page.keyboard.press("Enter");
  await page.keyboard.type("echo two");
  await expect
    .poll(async () =>
      page.evaluate(() => document.querySelector('[data-testid="integrated-terminal"]')?.textContent ?? ""),
    )
    .toContain("echo two");
  await page.keyboard.press("Enter");

  await expect
    .poll(async () =>
      page.evaluate(() => {
        const pty = (window as any).__PTY_TEST__;
        const text = pty?.writes?.join("") ?? "";
        return text.includes("echo one") &&
          text.includes("echo two") &&
          (pty?.enterCount ?? 0) >= 2 &&
          (pty?.spawns?.length ?? 0) >= 2;
      }),
    )
    .toBe(true);
});
