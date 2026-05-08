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
    let pseudoToolRecoveryRequests = 0;
    const requests: Array<{ hasTools: boolean; body: string }> = [];
    const readFileCalls: string[] = [];
    const ingestedAttachments: Array<{ sessionKey: string; sourcePath: string }> = [];

    (window as any).__CLOUD_TOOL_PROTOCOL_TEST__ = {
      requests,
      readFileCalls,
      ingestedAttachments,
      get fallbackNoToolRequests() {
        return fallbackNoToolRequests;
      },
      get pseudoToolRecoveryRequests() {
        return pseudoToolRecoveryRequests;
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
      if (cmd === "ingest_attachment_file") {
        const sourcePath = String(args?.sourcePath ?? "");
        ingestedAttachments.push({
          sessionKey: String(args?.sessionKey ?? ""),
          sourcePath,
        });
        if (sourcePath === "/tmp/e2e-outside-main-debug.log") {
          return {
            path: ".MAIN-chat-attachments/outside-main-debug.log",
            workspace: "/tmp/e2e-chat-temp",
            originalPath: sourcePath,
            displayName: "outside-main-debug.log",
            sizeBytes: 64,
          };
        }
        throw new Error(`unsupported attachment: ${sourcePath}`);
      }
      if (cmd === "glob_search") return [];
      if (cmd === "read_file_window") {
        const path = String(args?.path ?? "");
        const scenario = new URL(window.location.href).searchParams.get("e2eScenario");
        if (
          scenario === "local-file-read-approval" &&
          path === ".MAIN-chat-attachments/outside-main-debug.log" &&
          args?.workspace === "/tmp/e2e-chat-temp"
        ) {
          readFileCalls.push(path);
          return {
            path,
            content: "LOCAL_FILE_READ_OK: debug log line",
            startLine: 1,
            endLine: 1,
            totalLines: 1,
            totalChars: 34,
            returnedChars: 34,
            truncated: false,
          };
        }
        if (
          scenario === "game-studio-execute-reply-runtime" &&
          path === "Assets/Scripts/Entities/SnakeController.cs"
        ) {
          readFileCalls.push(path);
          return {
            path,
            content: "public class SnakeController {}",
            startLine: 1,
            endLine: 1,
            totalLines: 1,
            totalChars: 31,
            returnedChars: 31,
            truncated: false,
          };
        }
        if (path === "README.md" || /^README-\d+\.md$/.test(path)) {
          readFileCalls.push(path);
          return {
            path,
            content: "# README\n\nfallback-ok\n",
            startLine: 1,
            endLine: 3,
            totalLines: 3,
            totalChars: 22,
            returnedChars: 22,
            truncated: false,
          };
        }
        throw new Error(`ENOENT: ${path}`);
      }
      if (cmd === "read_file") {
        const path = String(args?.path ?? "");
        const scenario = new URL(window.location.href).searchParams.get("e2eScenario");
        if (
          scenario === "local-file-read-approval" &&
          path === ".MAIN-chat-attachments/outside-main-debug.log" &&
          args?.workspace === "/tmp/e2e-chat-temp"
        ) {
          readFileCalls.push(path);
          return "LOCAL_FILE_READ_OK: debug log line";
        }
        const planFiles: Record<string, string> = {
          ".MAIN/plans/requirements.md": [
            "# Requirements",
            "",
            "## 需求",
            "",
            "用户要求根据 `.MAIN/plans` 执行时，MAIN 必须恢复计划执行语义，同时暴露执行工具并保留逐项审查。",
            "",
            "## 验收",
            "",
            "- PlanPanel 显示任务。",
            "- runtime 工具包含 shell/write。",
          ].join("\n"),
          ".MAIN/plans/design.md": [
            "# Design",
            "",
            "## 方案",
            "",
            "在发送前 hydrate `.MAIN/plans`，conversation intent 保持 plan，runtime intent 使用 execute。",
            "",
            "## 验证",
            "",
            "- 下一轮模型请求包含 run_command。",
            "- 工具调用进入 ActionCard 审查。",
          ].join("\n"),
          ".MAIN/plans/tasks.md": [
            "# Tasks",
            "",
            "- [ ] 运行计划执行验证命令 `npm run test:workflow-assets` — 证据: cmd:npm run test:workflow-assets",
          ].join("\n"),
        };
        if (scenario === "existing-plan-folder-execute" && Object.prototype.hasOwnProperty.call(planFiles, path)) {
          readFileCalls.push(path);
          return planFiles[path];
        }
        if (
          scenario === "game-studio-execute-reply-runtime" &&
          path === "Assets/Scripts/Entities/SnakeController.cs"
        ) {
          readFileCalls.push(path);
          return "public class SnakeController {}";
        }
        if (path !== "README.md" && !/^README-\d+\.md$/.test(path)) {
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

        if (scenario === "execute-quick-reply-runtime") {
          if (body.includes("直接执行部署脚本 deploy.sh")) {
            return JSON.stringify({
              output_text: [
                "我会执行部署脚本。",
                "<tool_use>",
                "<tool>execute_command</tool>",
                "<parameter name=\"command\">./deploy.sh</parameter>",
                "<parameter name=\"cwd\">.</parameter>",
                "<parameter name=\"description\">执行部署脚本</parameter>",
                "</tool_use>",
              ].join("\n"),
            });
          }
          return JSON.stringify({
            output_text: [
              "部署方式已确认，请选择下一步。",
              "<user_options>",
              "<option>直接执行部署脚本 deploy.sh</option>",
              "<option>我来确认无误再执行</option>",
              "</user_options>",
            ].join("\n"),
          });
        }

        if (scenario === "game-studio-execute-reply-runtime") {
          if (body.includes("立即开始重构并完善")) {
            return JSON.stringify({
              output_text: [
                "我会读取 SnakeController 并开始重构。",
                "<tool_use>",
                "<tool>read_file</tool>",
                "<parameter name=\"path\">Assets/Scripts/Entities/SnakeController.cs</parameter>",
                "</tool_use>",
              ].join("\n"),
            });
          }
          return JSON.stringify({
            output_text: [
              "我需要确认是否进入执行能力继续。",
              "<user_options>",
              "<option>立即开始重构并完善</option>",
              "<option>先继续讨论方案</option>",
              "</user_options>",
            ].join("\n"),
          });
        }

        if (scenario === "pseudo-tool-call-recovery") {
          if (body.includes("READ_FILE_RESULT") || body.includes("fallback-ok")) {
            return JSON.stringify({
              output_text: "已读取 README.md，确认包含 fallback-ok。",
            });
          }
          if (body.includes("不是可执行工具调用") || body.includes("not an executable tool call")) {
            pseudoToolRecoveryRequests += 1;
            return JSON.stringify({
              output_text: [
                "我会改用正式 XML 工具调用读取文件。",
                "<tool_use>",
                "<tool>read_file</tool>",
                "<parameter name=\"path\">README.md</parameter>",
                "</tool_use>",
              ].join("\n"),
            });
          }
          return JSON.stringify({
            output_text: "[Tool call: read_file]",
          });
        }

        if (scenario === "existing-plan-folder-execute") {
          return JSON.stringify({
            output_text: [
              "我会执行计划任务中的验证命令。",
              "<tool_use>",
              "<tool>run_command</tool>",
              "<parameter name=\"command\">npm run test:workflow-assets</parameter>",
              "<parameter name=\"cwd\">.</parameter>",
              "<parameter name=\"description\">运行计划任务验证命令</parameter>",
              "</tool_use>",
            ].join("\n"),
          });
        }

        if (scenario === "execute-max-iterations-checkpoint") {
          return JSON.stringify({
            output_text: [
              "继续读取下一份检查材料。",
              "<tool_use>",
              "<tool>read_file</tool>",
              `<parameter name=\"path\">README-${requests.length}.md</parameter>`,
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

        if (scenario === "local-file-read-approval") {
          if (body.includes("LOCAL_FILE_READ_OK")) {
            return JSON.stringify({
              output_text: "已读取外部日志，确认包含 LOCAL_FILE_READ_OK。",
            });
          }
          if (body.includes("User rejected reading this local file outside the workspace")) {
            return JSON.stringify({
              output_text: "已按拒绝处理，没有读取外部日志。",
            });
          }
          return JSON.stringify({
            output_text: [
              "我会读取外部日志。",
              "<tool_use>",
              "<tool>read_file</tool>",
              "<parameter name=\"path\">/tmp/e2e-outside-main-debug.log</parameter>",
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

test("execute quick reply switches a discuss turn to execute runtime and keeps tool review", async ({ page }) => {
  await page.goto("/?e2eScenario=execute-quick-reply-runtime");

  const sent = await page.evaluate(() =>
    (window as any).__CODELY_E2E__?.sendCloudMessage?.("请检查部署方式并让我选择下一步。"),
  );
  expect(sent).toBe(true);

  await expect(page.getByTestId("top-island-awaiting-choice")).toBeVisible();
  await expect(page.getByTestId("top-island-reply-option-0")).toContainText("直接执行部署脚本");

  await page.getByTestId("top-island-reply-option-0").click();

  await expect
    .poll(async () =>
      page.evaluate(() => {
        const probe = (window as any).__CLOUD_TOOL_PROTOCOL_TEST__;
        const requests = probe?.requests || [];
        const executionRequest = [...requests]
          .reverse()
          .find((request: any) => request.hasTools && String(request.body || "").includes("直接执行部署脚本 deploy.sh"));
        if (!executionRequest) return null;
        const parsed = JSON.parse(executionRequest.body || "{}");
        const names = (parsed.tools || []).map((tool: any) => tool?.name || tool?.function?.name).filter(Boolean);
        const snapshot = (window as any).__CODELY_E2E__?.getSnapshot?.();
        return {
          hasShell: names.includes("run_command") && names.includes("execute_command"),
          currentTurnIntent: snapshot?.currentTurnIntent,
          agentStatus: snapshot?.agentStatus,
          hasExecuteToolBlock: (snapshot?.toolNames || []).includes("execute_command"),
        };
      }),
    )
    .toEqual({
      hasShell: true,
      currentTurnIntent: "execute",
      agentStatus: "pending_review",
      hasExecuteToolBlock: true,
    });
});

test("game studio execute reply resumes the source turn with studio workflow tools", async ({ page }) => {
  await page.goto("/?e2eScenario=game-studio-execute-reply-runtime");

  const sent = await page.evaluate(() =>
    (window as any).__CODELY_E2E__?.sendCloudMessage?.("请检查 SnakeController 下一步。"),
  );
  expect(sent).toBe(true);

  await expect(page.getByTestId("top-island-awaiting-choice")).toBeVisible();
  await expect(page.getByTestId("top-island-reply-option-0")).toContainText("立即开始重构并完善");

  await page.getByTestId("top-island-reply-option-0").click();

  await expect
    .poll(async () =>
      page.evaluate(() => {
        const probe = (window as any).__CLOUD_TOOL_PROTOCOL_TEST__;
        const requests = probe?.requests || [];
        const executionRequest = [...requests]
          .reverse()
          .find((request: any) => request.hasTools && String(request.body || "").includes("立即开始重构并完善"));
        if (!executionRequest) return null;
        const parsed = JSON.parse(executionRequest.body || "{}");
        const names = (parsed.tools || []).map((tool: any) => tool?.name || tool?.function?.name).filter(Boolean);
        const snapshot = (window as any).__CODELY_E2E__?.getSnapshot?.();
        return {
          hasRead: names.includes("read_file"),
          hasWrite: names.includes("write_file") && names.includes("replace_in_file"),
          currentTurnIntent: snapshot?.currentTurnIntent,
          turns: snapshot?.conversationTurns,
          archivedOptionCount: snapshot?.archivedOptionCount,
          readFileCalls: probe?.readFileCalls || [],
        };
      }),
    )
    .toEqual({
      hasRead: true,
      hasWrite: true,
      currentTurnIntent: "studio_workflow",
      turns: 1,
      archivedOptionCount: 1,
      readFileCalls: ["Assets/Scripts/Entities/SnakeController.cs"],
    });
});

test("pseudo tool call placeholder triggers XML recovery instead of stopping as final text", async ({ page }) => {
  await page.goto("/?e2eScenario=pseudo-tool-call-recovery");

  const sent = await page.evaluate(() =>
    (window as any).__CODELY_E2E__?.sendCloudMessage?.("请读取 README.md。"),
  );
  expect(sent).toBe(true);

  await expect(page.getByText("我会改用正式 XML 工具调用读取文件。")).toBeVisible();
  await expect(page.getByText("[Tool call: read_file]")).toHaveCount(0);

  await expect
    .poll(async () =>
      page.evaluate(() => {
        const probe = (window as any).__CLOUD_TOOL_PROTOCOL_TEST__;
        return {
          recoveryRequests: probe?.pseudoToolRecoveryRequests ?? 0,
          readFileCalls: probe?.readFileCalls || [],
        };
      }),
    )
    .toEqual({
      recoveryRequests: 1,
      readFileCalls: ["README.md"],
    });
});

test("existing .MAIN/plans execution hydrates approved plan and exposes execute tools", async ({ page }) => {
  await page.goto("/?e2eScenario=existing-plan-folder-execute");

  const sent = await page.evaluate(() =>
    (window as any).__CODELY_E2E__?.sendCloudMessage?.("根据.MAIN/plans文件夹的内容，完成执行方案和任务的内容。"),
  );
  expect(sent).toBe(true);

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
          hydratedFiles: probe?.readFileCalls || [],
          hasShell: names.includes("run_command") && names.includes("execute_command"),
          hasWrite: names.includes("write_file") && names.includes("replace_in_file"),
          currentTurnIntent: snapshot?.currentTurnIntent,
          isPlanApproved: snapshot?.isPlanApproved,
          planStage: snapshot?.planStage,
          planTaskCount: snapshot?.planTasks?.length || 0,
          agentStatus: snapshot?.agentStatus,
          hasRunCommandToolBlock: (snapshot?.toolNames || []).includes("run_command"),
        };
      }),
    )
    .toEqual({
      hydratedFiles: [
        ".MAIN/plans/requirements.md",
        ".MAIN/plans/design.md",
        ".MAIN/plans/tasks.md",
      ],
      hasShell: true,
      hasWrite: true,
      currentTurnIntent: "plan",
      isPlanApproved: true,
      planStage: "executing",
      planTaskCount: 1,
      agentStatus: "pending_review",
      hasRunCommandToolBlock: true,
    });
});

test("ordinary execute max iterations creates a recovery checkpoint instead of an error card", async ({ page }) => {
  test.setTimeout(45_000);
  await page.goto("/?e2eScenario=execute-max-iterations-checkpoint");

  const sent = await page.evaluate(() =>
    (window as any).__CODELY_E2E__?.sendCloudMessage?.("请直接执行一个需要多轮检查的长任务。"),
  );
  expect(sent).toBe(true);

  await expect
    .poll(async () =>
      page.evaluate(() => {
        const snapshot = (window as any).__CODELY_E2E__?.getSnapshot?.();
        const systemTexts = snapshot?.systemTexts || [];
        return {
          hasRecoveryCheckpoint: systemTexts.some((text: string) => /安全边界|恢复点/.test(text)),
          hasPauseAfterAutoResume: systemTexts.some((text: string) => /执行已暂停|Execution paused/.test(text)),
          autoResumeCount: snapshot?.planAutoResumeCount ?? 0,
          hasErrorTool: (snapshot?.toolNames || []).includes("Error"),
        };
      }),
      { timeout: 35_000 },
    )
    .toEqual({
      hasRecoveryCheckpoint: true,
      hasPauseAfterAutoResume: true,
      autoResumeCount: 1,
      hasErrorTool: false,
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

test("workspace-external local file reads request approval before ingesting and reading", async ({ page }) => {
  await page.goto("/?e2eScenario=local-file-read-approval");

  const sent = await page.evaluate(() =>
    (window as any).__CODELY_E2E__?.sendCloudMessage?.("请读取外部日志 /tmp/e2e-outside-main-debug.log。"),
  );
  expect(sent).toBe(true);

  await expect
    .poll(async () =>
      page.evaluate(() => {
        const snapshot = (window as any).__CODELY_E2E__?.getSnapshot?.();
        const probe = (window as any).__CLOUD_TOOL_PROTOCOL_TEST__;
        return {
          agentStatus: snapshot?.agentStatus,
          toolNames: snapshot?.toolNames || [],
          toolTargets: snapshot?.toolTargets || [],
          toolStatuses: snapshot?.toolStatuses || [],
          ingested: probe?.ingestedAttachments || [],
          readFileCalls: probe?.readFileCalls || [],
        };
      }),
    )
    .toEqual({
      agentStatus: "pending_review",
      toolNames: ["read_file"],
      toolTargets: ["/tmp/e2e-outside-main-debug.log"],
      toolStatuses: ["pending"],
      ingested: [],
      readFileCalls: [],
    });

  await page.getByText("允许执行").click();

  await expect(page.getByText("已读取外部日志，确认包含 LOCAL_FILE_READ_OK。")).toBeVisible();

  await expect
    .poll(async () =>
      page.evaluate(() => {
        const snapshot = (window as any).__CODELY_E2E__?.getSnapshot?.();
        const probe = (window as any).__CLOUD_TOOL_PROTOCOL_TEST__;
        return {
          agentStatus: snapshot?.agentStatus,
          toolStatuses: snapshot?.toolStatuses || [],
          ingested: probe?.ingestedAttachments || [],
          readFileCalls: probe?.readFileCalls || [],
        };
      }),
    )
    .toEqual({
      agentStatus: "idle",
      toolStatuses: ["executed"],
      ingested: [
        {
          sessionKey: "/tmp/e2e-local-file-read-approval:999506",
          sourcePath: "/tmp/e2e-outside-main-debug.log",
        },
      ],
      readFileCalls: [".MAIN-chat-attachments/outside-main-debug.log"],
    });
});

test("workspace-external local file read rejection fails without ingesting or reading", async ({ page }) => {
  await page.goto("/?e2eScenario=local-file-read-approval");

  const sent = await page.evaluate(() =>
    (window as any).__CODELY_E2E__?.sendCloudMessage?.("请读取外部日志 /tmp/e2e-outside-main-debug.log。"),
  );
  expect(sent).toBe(true);

  await expect
    .poll(async () =>
      page.evaluate(() => {
        const snapshot = (window as any).__CODELY_E2E__?.getSnapshot?.();
        const probe = (window as any).__CLOUD_TOOL_PROTOCOL_TEST__;
        return {
          agentStatus: snapshot?.agentStatus,
          toolNames: snapshot?.toolNames || [],
          toolTargets: snapshot?.toolTargets || [],
          toolStatuses: snapshot?.toolStatuses || [],
          ingested: probe?.ingestedAttachments || [],
          readFileCalls: probe?.readFileCalls || [],
        };
      }),
    )
    .toEqual({
      agentStatus: "pending_review",
      toolNames: ["read_file"],
      toolTargets: ["/tmp/e2e-outside-main-debug.log"],
      toolStatuses: ["pending"],
      ingested: [],
      readFileCalls: [],
    });

  await page.getByTestId("chat-scroll-container").getByRole("button", { name: "拒绝" }).click();

  await expect
    .poll(async () =>
      page.evaluate(() => {
        const snapshot = (window as any).__CODELY_E2E__?.getSnapshot?.();
        const probe = (window as any).__CLOUD_TOOL_PROTOCOL_TEST__;
        return {
          agentStatus: snapshot?.agentStatus,
          toolStatuses: snapshot?.toolStatuses || [],
          ingested: probe?.ingestedAttachments || [],
          readFileCalls: probe?.readFileCalls || [],
        };
      }),
    )
    .toEqual({
      agentStatus: "idle",
      toolStatuses: ["rejected"],
      ingested: [],
      readFileCalls: [],
    });
});
