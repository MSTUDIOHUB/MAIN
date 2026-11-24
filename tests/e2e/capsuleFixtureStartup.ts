import type { Page } from "@playwright/test";

/** Allow seeded Capsule sessions to pass native startup migration in a browser. */
export async function installCapsuleFixtureStartup(page: Page) {
  await page.addInitScript(() => {
    if (!window.sessionStorage.getItem("__CODELY_E2E_STORAGE_RESET__")) {
      window.localStorage.clear();
      window.sessionStorage.setItem("__CODELY_E2E_STORAGE_RESET__", "1");
    }
    let callback = 0;
    (window as any).__TAURI_EVENT_PLUGIN_INTERNALS__ ??= { unregisterListener() {} };
    (window as any).__TAURI_INTERNALS__ ??= {
      metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
      transformCallback: () => ++callback,
      unregisterCallback() {},
      invoke: async (command: string) => {
        if (command === "plugin:event|listen") return ++callback;
        if (["list_all_session_snapshots", "list_legacy_session_files", "list_project_sessions", "rebuild_project_sessions_index", "discover_personal_agent_skills"].includes(command)) return [];
        if (command === "cleanup_legacy_image_studio_outputs") return { removedDirectories: 0 };
        return null;
      },
    };
  });
}
