import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    if (!window.sessionStorage.getItem("__CODELY_E2E_STORAGE_RESET__")) {
      window.localStorage.clear();
      window.sessionStorage.setItem("__CODELY_E2E_STORAGE_RESET__", "1");
    }

    let callbackId = 1;
    const callbacks = new Map<number, unknown>();
    let fallbackNoToolRequests = 0;
    const requests: Array<{ hasTools: boolean; body: string }> = [];
    const readFileCalls: string[] = [];

    (window as any).__CLOUD_TOOL_PROTOCOL_TEST__ = {
      requests,
      readFileCalls,
      get fallbackNoToolRequests() {
        return fallbackNoToolRequests;
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
      if (cmd === "plugin:event|listen") return Number(args?.handler ?? callbackId++);
      if (cmd === "plugin:event|unlisten") return null;
      if (cmd === "get_system_memory") return { total_gb: 32, available_gb: 24 };
      if (cmd === "set_workspace_root") return String(args?.path ?? "");
      if (cmd === "get_workspace_root") return "/tmp/e2e-cloud-tool-protocol";
      if (cmd === "list_project_sessions" || cmd === "rebuild_project_sessions_index") return [];
      if (cmd === "save_project_session") return args?.session ?? {};
      if (cmd === "load_project_session") return {};
      if (cmd === "get_file_metadata") {
        return { path: String(args?.path ?? ""), sizeBytes: 32, modifiedMs: 1 };
      }
      if (cmd === "glob_search") return [];
      if (cmd === "read_file") {
        const path = String(args?.path ?? "");
        if (path !== "README.md") {
          throw new Error(`ENOENT: ${path}`);
        }
        readFileCalls.push(path);
        return "# README\n\nfallback-ok\n";
      }

      if (cmd === "proxy_request") {
        const scenario = new URL(window.location.href).searchParams.get("e2eScenario");
        const body = String(args?.body ?? "{}");
        const parsed = JSON.parse(body);
        const hasTools = Array.isArray(parsed.tools) && parsed.tools.length > 0;
        requests.push({ hasTools, body });

        if (scenario === "cloud-tool-fallback") {
          if (hasTools) {
            throw new Error("HTTP 400: invalid_request_error unsupported parameter: 'tools'");
          }

          fallbackNoToolRequests += 1;
          if (fallbackNoToolRequests === 1) {
            return JSON.stringify({
              output_text: "我没有可以调用的工具，无法访问 README.md。",
            });
          }
          if (fallbackNoToolRequests === 2) {
            return JSON.stringify({
              output_text: [
                "我会改用 MAIN XML 工具读取文件。",
                "<tool_use>",
                "<tool>read_file</tool>",
                "<parameter name=\"path\">README.md</parameter>",
                "</tool_use>",
              ].join("\n"),
            });
          }
          return JSON.stringify({
            output_text: "已读取 README.md，确认包含 fallback-ok。",
          });
        }

        if (scenario === "reply-options-tool-pause") {
          if (body.includes("请采用保守方案继续")) {
            return JSON.stringify({
              output_text: "已按保守方案继续，当前回合保持完整。",
            });
          }
          return JSON.stringify({
            output_text: [
              "这里需要你先选择一个方向。",
              "<user_options>",
              "<option value=\"请采用保守方案继续。\">保守方案</option>",
              "<option label=\"直接实现\" value=\"请直接实现最小改动。\"></option>",
              "</user_options>",
              "<tool_use>",
              "<tool>read_file</tool>",
              "<parameter name=\"path\">README.md</parameter>",
              "</tool_use>",
            ].join("\n"),
          });
        }

        if (scenario === "plan-approval-execute-tools") {
          return JSON.stringify({
            output_text: [
              "我会先写入执行任务清单。",
              "<tool_use>",
              "<tool>write_file</tool>",
              "<parameter name=\"path\">.MAIN/plans/tasks.md</parameter>",
              "<parameter name=\"content\"># Tasks\n\n- [ ] 验证批准后执行工具可用</parameter>",
              "</tool_use>",
            ].join("\n"),
          });
        }

        return JSON.stringify({ output_text: "ok" });
      }

      return null;
    };
  });
});

test("cloud Responses falls back from native tools to XML tools and reprompts tool-unavailable claims", async ({ page }) => {
  await page.goto("/?e2eScenario=cloud-tool-fallback");

  const sent = await page.evaluate(() => (window as any).__CODELY_E2E__?.sendCloudMessage?.());
  expect(sent).toBe(true);

  await expect(page.getByText("已读取 README.md，确认包含 fallback-ok。")).toBeVisible();
  await expect(page.getByText("我没有可以调用的工具")).toHaveCount(0);

  await expect
    .poll(async () =>
      page.evaluate(() => {
        const probe = (window as any).__CLOUD_TOOL_PROTOCOL_TEST__;
        return {
          attemptedNativeTools: probe?.requests?.some((request: any) => request.hasTools) ?? false,
          retriedWithoutNativeTools: (probe?.requests || []).some((request: any) => !request.hasTools),
          readFileCalls: probe?.readFileCalls || [],
          noToolRequests: probe?.fallbackNoToolRequests ?? 0,
        };
      }),
    )
    .toEqual({
      attemptedNativeTools: true,
      retriedWithoutNativeTools: true,
      readFileCalls: ["README.md"],
      noToolRequests: 3,
    });
});

test("reply options pause before mixed XML tool calls and continue from the source turn", async ({ page }) => {
  await page.goto("/?e2eScenario=reply-options-tool-pause");

  const sent = await page.evaluate(() =>
    (window as any).__CODELY_E2E__?.sendCloudMessage?.("请检查后让我选择下一步。"),
  );
  expect(sent).toBe(true);

  await expect(page.getByTestId("top-island-awaiting-choice")).toBeVisible();
  await expect(page.getByTestId("top-island-reply-option-0")).toContainText("保守方案");

  await expect
    .poll(async () =>
      page.evaluate(() => {
        const snapshot = (window as any).__CODELY_E2E__?.getSnapshot?.();
        const probe = (window as any).__CLOUD_TOOL_PROTOCOL_TEST__;
        return {
          status: snapshot?.currentTurnStatus,
          optionBlockCount: snapshot?.optionBlockCount,
          readFileCalls: probe?.readFileCalls?.length ?? -1,
        };
      }),
    )
    .toEqual({
      status: "awaiting_input",
      optionBlockCount: 1,
      readFileCalls: 0,
    });

  await page.getByTestId("top-island-reply-option-0").click();
  await expect(page.getByText("已按保守方案继续，当前回合保持完整。")).toBeVisible();

  await expect
    .poll(async () =>
      page.evaluate(() => {
        const snapshot = (window as any).__CODELY_E2E__?.getSnapshot?.();
        const probe = (window as any).__CLOUD_TOOL_PROTOCOL_TEST__;
        return {
          status: snapshot?.currentTurnStatus,
          turns: snapshot?.conversationTurns,
          users: snapshot?.taskFlowUserCount,
          archivedOptionCount: snapshot?.archivedOptionCount,
          selectedOptions: snapshot?.selectedOptions,
          readFileCalls: probe?.readFileCalls?.length ?? -1,
        };
      }),
    )
    .toEqual({
      status: "done",
      turns: 1,
      users: 2,
      archivedOptionCount: 1,
      selectedOptions: ["请采用保守方案继续"],
      readFileCalls: 0,
    });
});

test("approved plan resumes with execute runtime tools while preserving plan turn identity", async ({ page }) => {
  await page.goto("/?e2eScenario=plan-approval-execute-tools");

  await expect(page.getByTestId("top-island-plan-approve")).toBeVisible();
  await page.getByTestId("top-island-plan-approve").click();

  await expect
    .poll(async () =>
      page.evaluate(() => {
        const probe = (window as any).__CLOUD_TOOL_PROTOCOL_TEST__;
        const requests = probe?.requests || [];
        const latestWithTools = [...requests].reverse().find((request: any) => request.hasTools);
        if (!latestWithTools) return null;
        const parsed = JSON.parse(latestWithTools.body || "{}");
        const names = (parsed.tools || []).map((tool: any) => tool?.name || tool?.function?.name).filter(Boolean);
        const snapshot = (window as any).__CODELY_E2E__?.getSnapshot?.();
        return {
          hasWrite: names.includes("write_file") && names.includes("replace_in_file"),
          hasShell: names.includes("run_command") && names.includes("execute_command"),
          currentTurnIntent: snapshot?.currentTurnIntent,
          isPlanApproved: snapshot?.isPlanApproved,
        };
      }),
    )
    .toEqual({
      hasWrite: true,
      hasShell: true,
      currentTurnIntent: "plan",
      isPlanApproved: true,
    });

  await expect
    .poll(async () =>
      page.evaluate(() => {
        const snapshot = (window as any).__CODELY_E2E__?.getSnapshot?.();
        return {
          hasWriteToolBlock: (snapshot?.toolNames || []).includes("write_file"),
          hasExecutionAgentText: (snapshot?.agentTexts || []).includes("我会先写入执行任务清单。"),
        };
      }),
    )
    .toEqual({
      hasWriteToolBlock: true,
      hasExecutionAgentText: true,
    });
});
