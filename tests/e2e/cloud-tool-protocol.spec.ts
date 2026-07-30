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
    let getProjectSkeletonCalls = 0;
    const requests: Array<{ hasTools: boolean; body: string }> = [];
    const readFileCalls: string[] = [];
    const listDirectoryCalls: string[] = [];
    const ingestedAttachments: Array<{
      sessionKey: string;
      sourcePath: string;
    }> = [];

    (window as any).__CLOUD_TOOL_PROTOCOL_TEST__ = {
      requests,
      readFileCalls,
      listDirectoryCalls,
      ingestedAttachments,
      get getProjectSkeletonCalls() {
        return getProjectSkeletonCalls;
      },
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
      if (cmd === "plugin:event|listen")
        return Number(args?.handler ?? callbackId++);
      if (cmd === "plugin:event|unlisten") return null;
      if (cmd === "get_system_memory")
        return { total_gb: 32, available_gb: 24 };
      if (cmd === "set_workspace_root") return String(args?.path ?? "");
      if (cmd === "get_workspace_root") return "/tmp/e2e-cloud-tool-protocol";
      if (cmd === "shell_permission_preflight") {
        const command = String(args?.command ?? "");
        return {
          command,
          decision: "allow",
          source: "e2e",
          segmentDecisions: [{ command, decision: "allow", riskLevel: "low" }],
          riskLevel: "low",
          requiresApproval: false,
        };
      }
      if (
        cmd === "list_project_sessions" ||
        cmd === "rebuild_project_sessions_index"
      )
        return [];
      if (cmd === "save_project_session") return args?.session ?? {};
      if (cmd === "load_project_session") return {};
      if (cmd === "get_file_metadata") {
        const path = String(args?.path ?? "");
        return { path, sizeBytes: 64, modifiedMs: 1 };
      }
      if (cmd === "get_project_skeleton") {
        getProjectSkeletonCalls += 1;
        return "README.md\nsrc/\n";
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
      if (cmd === "get_chat_temp_root") return "/tmp/e2e-chat-temp";
      if (cmd === "glob_search") return [];
      if (cmd === "list_directory") {
        const path = String(args?.path ?? "");
        listDirectoryCalls.push(path);
        return [];
      }
      if (cmd === "read_file_window" || cmd === "read_file") {
        const path = String(args?.path ?? "");
        const scenario = new URL(window.location.href).searchParams.get(
          "e2eScenario",
        );
        const isExternalAttachment =
          (scenario === "local-file-read-approval" ||
            scenario === "global-chat-attachment-read") &&
          path === ".MAIN-chat-attachments/outside-main-debug.log" &&
          args?.workspace === "/tmp/e2e-chat-temp";
        if (isExternalAttachment) {
          readFileCalls.push(path);
          const content =
            scenario === "global-chat-attachment-read"
              ? "GLOBAL_ATTACHMENT_READ_OK: debug log line"
              : "LOCAL_FILE_READ_OK: debug log line";
          if (cmd === "read_file") return content;
          return {
            path,
            content,
            startLine: 1,
            endLine: 1,
            totalLines: 1,
            totalChars: content.length,
            returnedChars: content.length,
            truncated: false,
            contentVersion:
              scenario === "global-chat-attachment-read"
                ? "sha256-56f5a986597d14a1631438aaa26c4eb3bc435a17a17eeb6f976b46a2e83b4b18"
                : "sha256-bbeb9b7524b44f433aa6e1b39f8aeddd476f64e21846a2c4b243a15aee44e4d0",
          };
        }
        if (path === "README.md") {
          readFileCalls.push(path);
          const content = "# README\n\nfallback-ok\n";
          if (cmd === "read_file") return content;
          return {
            path,
            content,
            startLine: 1,
            endLine: 3,
            totalLines: 3,
            totalChars: content.length,
            returnedChars: content.length,
            truncated: false,
            contentVersion:
              "sha256-ff19f11929c18ff7a0d942a634a2b90c7a356bf5aa231b141acfec31950d5a98",
          };
        }
        throw new Error(`ENOENT: ${path}`);
      }

      if (cmd === "proxy_request") {
        // Match real IPC scheduling so multi-step Runtime requests yield to React.
        await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
        const scenario = new URL(window.location.href).searchParams.get(
          "e2eScenario",
        );
        const body = String(args?.body ?? "{}");
        const parsed = JSON.parse(body);
        const hasTools = Array.isArray(parsed.tools) && parsed.tools.length > 0;
        if (body.includes("hidden semantic title generator")) {
          return JSON.stringify({
            output_text: JSON.stringify({
              title: "外部日志读取",
              summary: "读取外部日志并确认标记",
            }),
          });
        }
        requests.push({ hasTools, body });

        if (scenario === "cloud-tool-fallback") {
          if (hasTools) {
            throw new Error(
              "HTTP 400: invalid_request_error unsupported parameter: 'tools'",
            );
          }
          fallbackNoToolRequests += 1;
          if (readFileCalls.includes("README.md")) {
            return JSON.stringify({
              output_text: "已读取 README.md，确认包含 fallback-ok。",
            });
          }
          return JSON.stringify({
            output_text:
              '<runtime-v2-tools>{"toolCalls":[{"id":"fallback-read","name":"read_file","arguments":{"path":"README.md"}}]}</runtime-v2-tools>',
          });
        }

        if (scenario === "progress-narration-tool-flow") {
          if (readFileCalls.includes("README.md")) {
            return JSON.stringify({
              output_text:
                "已确认 README.md 包含 fallback-ok，进度展示链路没有暴露原始工具协议。",
            });
          }
          return hasTools
            ? JSON.stringify({
                output: [
                  {
                    type: "function_call",
                    call_id: "progress-read",
                    name: "read_file",
                    arguments: JSON.stringify({ path: "README.md" }),
                  },
                ],
              })
            : JSON.stringify({
                output_text:
                  '<runtime-v2-tools>{"toolCalls":[{"id":"progress-read","name":"read_file","arguments":{"path":"README.md"}}]}</runtime-v2-tools>',
              });
        }

        if (scenario === "ordinary-continue-new-turn") {
          if (readFileCalls.includes("README.md")) {
            return JSON.stringify({
              output_text: "已在新回合继续处理旧任务上下文。",
            });
          }
          return hasTools
            ? JSON.stringify({
                output: [
                  {
                    type: "function_call",
                    call_id: "continued-read",
                    name: "read_file",
                    arguments: JSON.stringify({ path: "README.md" }),
                  },
                ],
              })
            : JSON.stringify({
                output_text:
                  '<runtime-v2-tools>{"toolCalls":[{"id":"continued-read","name":"read_file","arguments":{"path":"README.md"}}]}</runtime-v2-tools>',
              });
        }

        if (scenario === "local-file-read-approval") {
          if (
            readFileCalls.includes(
              ".MAIN-chat-attachments/outside-main-debug.log",
            )
          ) {
            return JSON.stringify({
              output_text: "已读取外部日志，确认包含 LOCAL_FILE_READ_OK。",
            });
          }
          return hasTools
            ? JSON.stringify({
                output: [
                  {
                    type: "function_call",
                    call_id: "external-local-file-read",
                    name: "read_file",
                    arguments: JSON.stringify({
                      path: "/tmp/e2e-outside-main-debug.log",
                    }),
                  },
                ],
              })
            : JSON.stringify({
                output_text:
                  '<runtime-v2-tools>{"toolCalls":[{"id":"external-local-file-read","name":"read_file","arguments":{"path":"/tmp/e2e-outside-main-debug.log"}}]}</runtime-v2-tools>',
              });
        }

        if (scenario === "global-chat-tool-scope") {
          return JSON.stringify({ output_text: "全局聊天未使用项目工具。" });
        }

        if (scenario === "global-chat-attachment-read") {
          if (
            readFileCalls.includes(
              ".MAIN-chat-attachments/outside-main-debug.log",
            )
          ) {
            return JSON.stringify({
              output_text: "已读取附件，确认包含 GLOBAL_ATTACHMENT_READ_OK。",
            });
          }
          return hasTools
            ? JSON.stringify({
                output: [
                  {
                    type: "function_call",
                    call_id: "global-attachment-read",
                    name: "read_file",
                    arguments: JSON.stringify({
                      path: ".MAIN-chat-attachments/outside-main-debug.log",
                    }),
                  },
                ],
              })
            : JSON.stringify({
                output_text:
                  '<runtime-v2-tools>{"toolCalls":[{"id":"global-attachment-read","name":"read_file","arguments":{"path":".MAIN-chat-attachments/outside-main-debug.log"}}]}</runtime-v2-tools>',
              });
        }

        return JSON.stringify({ output_text: "ok" });
      }

      return null;
    };
  });
});

test("cloud Responses falls back from native tools to the Runtime v2 text envelope", async ({
  page,
}) => {
  await page.goto("/?e2eScenario=cloud-tool-fallback");

  const sent = await page.evaluate(() =>
    (window as any).__CODELY_E2E__?.sendCloudMessage?.(),
  );
  expect(sent).toBe(true);

  await expect(
    page.getByText("已读取 README.md，确认包含 fallback-ok。"),
  ).toBeVisible();

  await expect
    .poll(async () =>
      page.evaluate(() => {
        const probe = (window as any).__CLOUD_TOOL_PROTOCOL_TEST__;
        return {
          attemptedNativeTools:
            probe?.requests?.some((request: any) => request.hasTools) ?? false,
          retriedWithoutNativeTools: (probe?.requests || []).some(
            (request: any) => !request.hasTools,
          ),
          readFileCalls: probe?.readFileCalls || [],
          fallbackNoToolRequests: probe?.fallbackNoToolRequests ?? 0,
        };
      }),
    )
    .toEqual({
      attemptedNativeTools: true,
      retriedWithoutNativeTools: true,
      readFileCalls: ["README.md"],
      fallbackNoToolRequests: 2,
    });
});

test("tool flow shows progress narration without exposing raw protocol", async ({
  page,
}) => {
  await page.goto("/?e2eScenario=progress-narration-tool-flow");

  const sent = await page.evaluate(() =>
    (window as any).__CODELY_E2E__?.sendCloudMessage?.(
      "请读取 README.md 并确认是否包含 fallback-ok。",
    ),
  );
  expect(sent).toBe(true);

  await expect(
    page.getByText("已确认 README.md 包含 fallback-ok"),
  ).toBeVisible();
  await expect(page.locator("body")).not.toContainText("<tool_use>");
  await expect(page.locator("body")).not.toContainText('"toolName"');
  await expect(page.locator("body")).not.toContainText("<analysis>");
  const processDisclosure = page.getByTestId("turn-process-archive-toggle");
  await expect(processDisclosure).toBeVisible();
  await expect(processDisclosure).toHaveAttribute("aria-expanded", "false");
  await processDisclosure.click();
  await expect(processDisclosure).toHaveAttribute("aria-expanded", "true");
  await expect(
    page.getByText("已确认 README.md 包含 fallback-ok"),
  ).toBeVisible();
  await expect(
    page.getByTestId("turn-archive-step").filter({ hasText: "README.md" }),
  ).toBeVisible();
  await expect(page.getByTestId("read-context-group-summary")).toHaveCount(0);
});

test("global chat without explicit files does not expose workspace tools", async ({
  page,
}) => {
  await page.goto("/?e2eScenario=global-chat-tool-scope");

  const sent = await page.evaluate(() =>
    (window as any).__CODELY_E2E__?.sendCloudMessage?.(
      "这是全局聊天，请直接回答一个普通问题。",
    ),
  );
  expect(sent).toBe(true);

  await expect(
    page
      .getByTestId("chat-scroll-container")
      .getByText("全局聊天未使用项目工具。"),
  ).toBeVisible();

  await expect
    .poll(async () =>
      page.evaluate(() => {
        const probe = (window as any).__CLOUD_TOOL_PROTOCOL_TEST__;
        const requests = probe?.requests || [];
        const latest = [...requests].reverse()[0];
        if (!latest) return null;
        const parsed = JSON.parse(latest.body || "{}");
        const names = (parsed.tools || [])
          .map((tool: any) => tool?.name || tool?.function?.name)
          .filter(Boolean);
        const workspaceToolNames = [
          "get_project_skeleton",
          "list_directory",
          "glob_search",
          "grep_search",
          "repo_map_status",
          "repo_map_search",
          "repo_map_context",
          "repo_map_files",
          "repo_map_impact",
          "get_file_outline",
          "index_workspace_documents",
          "write_file",
          "replace_in_file",
          "apply_patch",
          "delete_workspace_path",
          "run_command",
          "execute_command",
          "send_pty_input",
          "browser_evaluate",
        ];
        return {
          names,
          leakedWorkspaceTools: names.filter((name: string) =>
            workspaceToolNames.includes(name),
          ),
          listDirectoryCalls: probe?.listDirectoryCalls || [],
          bodyHasGlobalBoundary:
            String(latest.body || "").includes("[MAIN RUNTIME V2 CHAT]") &&
            String(latest.body || "").includes("Workspace label: global"),
          bodyHasFakeWorkspace: String(latest.body || "").includes(
            "/tmp/e2e-global-chat-tool-scope",
          ),
        };
      }),
    )
    .toEqual({
      names: [],
      leakedWorkspaceTools: [],
      listDirectoryCalls: [],
      bodyHasGlobalBoundary: true,
      bodyHasFakeWorkspace: false,
    });
});

test("global chat with an attachment only exposes attachment read tools", async ({
  page,
}) => {
  await page.goto("/?e2eScenario=global-chat-attachment-read");

  // E2E scenario controls are installed from the app mount effect. Wait for
  // the bridge rather than treating a just-completed navigation as proof that
  // React has committed the scenario, which made this direct call flaky.
  await expect
    .poll(async () =>
      page.evaluate(
        () => typeof (window as any).__CODELY_E2E__?.sendCloudMessage,
      ),
    )
    .toBe("function");

  const sent = await page.evaluate(() =>
    (window as any).__CODELY_E2E__?.sendCloudMessage?.(
      "请读取附件并确认标记。",
    ),
  );
  expect(sent).toBe(true);

  await expect(
    page
      .getByTestId("chat-scroll-container")
      .getByText("已读取附件，确认包含 GLOBAL_ATTACHMENT_READ_OK。"),
  ).toBeVisible();

  await expect
    .poll(async () =>
      page.evaluate(() => {
        const probe = (window as any).__CLOUD_TOOL_PROTOCOL_TEST__;
        const requests = probe?.requests || [];
        const toolNameSets = requests
          .filter((request: any) => request.hasTools)
          .map((request: any) => {
            const parsed = JSON.parse(request.body || "{}");
            return (parsed.tools || [])
              .map((tool: any) => tool?.name || tool?.function?.name)
              .filter(Boolean);
          });
        if (toolNameSets.length === 0) return null;
        const allowedAttachmentReadTools = [
          "read_file",
          "read_document",
          "analyze_tabular_document",
          "query_tabular_document",
        ];
        const names = [...new Set(toolNameSets.flat())];
        const snapshot = (window as any).__CODELY_E2E__?.getSnapshot?.();
        return {
          names: [...names].sort(),
          onlyAttachmentReadTools: toolNameSets.every(
            (requestNames: string[]) =>
              requestNames.length === allowedAttachmentReadTools.length &&
              requestNames.every((name: string) =>
                allowedAttachmentReadTools.includes(name),
              ),
          ),
          ingestedAttachments: probe?.ingestedAttachments || [],
          readFileCalls: probe?.readFileCalls || [],
          listDirectoryCalls: probe?.listDirectoryCalls || [],
          getProjectSkeletonCalls: probe?.getProjectSkeletonCalls ?? -1,
          visibleFinalCount: snapshot?.visibleFinalCount,
          resultKind: snapshot?.currentTurnResultKind,
        };
      }),
    )
    .toEqual({
      names: [
        "analyze_tabular_document",
        "query_tabular_document",
        "read_document",
        "read_file",
      ],
      onlyAttachmentReadTools: true,
      ingestedAttachments: [
        {
          sessionKey: "__MAIN_GLOBAL_CHAT__:999517",
          sourcePath: "/tmp/e2e-outside-main-debug.log",
        },
      ],
      readFileCalls: [".MAIN-chat-attachments/outside-main-debug.log"],
      listDirectoryCalls: [],
      getProjectSkeletonCalls: 0,
      visibleFinalCount: 1,
      resultKind: "success",
    });
});

test("ordinary continue after a canonical blocked execute terminal starts a new visible turn", async ({
  page,
}) => {
  await page.goto("/?e2eScenario=ordinary-continue-new-turn");

  const previousTurnId = "e2e-ordinary-continue-previous-turn";
  await expect
    .poll(async () =>
      page.evaluate((turnId) => {
        const snapshot = (window as any).__CODELY_E2E__?.getSnapshot?.();
        const previousTurn = snapshot?.visibleConversationTurns?.find(
          (turn: any) => turn.id === turnId,
        );
        return {
          conversationTurns: snapshot?.conversationTurns,
          currentTurnId: snapshot?.currentTurnId,
          previousStatus: previousTurn?.status,
          previousRuntimeStatus: previousTurn?.runtimeStatus,
          previousResultKind: previousTurn?.resultKind,
          previousBlockCount: previousTurn?.blockCount,
        };
      }, previousTurnId),
    )
    .toEqual({
      conversationTurns: 1,
      currentTurnId: previousTurnId,
      previousStatus: "done",
      previousRuntimeStatus: "completed",
      previousResultKind: "blocked",
      previousBlockCount: 3,
    });

  const sent = await page.evaluate(() =>
    (window as any).__CODELY_E2E__?.sendCloudMessage?.("继续"),
  );
  expect(sent).toBe(true);

  await expect
    .poll(
      async () =>
        page.evaluate((turnId) => {
          const snapshot = (window as any).__CODELY_E2E__?.getSnapshot?.();
          const turns = snapshot?.visibleConversationTurns || [];
          const previousTurn = turns.find((turn: any) => turn.id === turnId);
          const newTurn = turns.find((turn: any) => turn.id !== turnId);
          const userBlocks = (snapshot?.taskBlockSummaries || []).filter(
            (block: any) => block.type === "user",
          );
          return {
            conversationTurns: snapshot?.conversationTurns,
            currentTurnStatus: snapshot?.currentTurnStatus,
            currentTurnResultKind: snapshot?.currentTurnResultKind,
            currentTurnIsNew: snapshot?.currentTurnId !== turnId,
            previousBlockCount: previousTurn?.blockCount,
            newTurnIntent: newTurn?.intent,
            continueUserOnNewTurn: userBlocks.filter(
              (block: any) =>
                block.turnId !== turnId && block.content === "继续",
            ).length,
            continueUserOnPreviousTurn: userBlocks.filter(
              (block: any) =>
                block.turnId === turnId && block.content === "继续",
            ).length,
            hasBlockedConclusion: (snapshot?.agentTexts || []).some(
              (text: string) => String(text || "").includes("结果受到阻塞"),
            ),
            agentTexts: snapshot?.agentTexts || [],
          };
        }, previousTurnId),
      { timeout: 20_000 },
    )
    .toEqual({
      conversationTurns: 2,
      currentTurnStatus: "done",
      currentTurnResultKind: "success",
      currentTurnIsNew: true,
      previousBlockCount: 3,
      newTurnIntent: "respond",
      continueUserOnNewTurn: 1,
      continueUserOnPreviousTurn: 0,
      hasBlockedConclusion: false,
      agentTexts: expect.any(Array),
    });

  const turnSections = page.locator("section[data-turn-id]");
  await expect(turnSections).toHaveCount(2);
  await expect(page.getByTestId("turn-boundary-divider")).toHaveCount(1);
  const previousSection = page.locator(
    `section[data-turn-id='${previousTurnId}']`,
  );
  await expect(previousSection).toHaveAttribute(
    "data-turn-presentation",
    "blocked",
  );
  await expect(previousSection).toContainText("请修复 README 检查链路并验证");
  await expect(
    previousSection,
  ).toContainText("我已经定位到 README 检查链路");

  const continuedTurnId = await page.evaluate(
    () => (window as any).__CODELY_E2E__?.getSnapshot?.().currentTurnId ?? "",
  );
  const continuedSection = page.locator(
    `section[data-turn-id='${continuedTurnId}']`,
  );
  await expect(continuedSection).toHaveAttribute(
    "data-turn-presentation",
    "ordinary",
  );
  await expect(continuedSection.getByTestId("turn-state-anchor")).toHaveCount(
    1,
  );
  await expect(continuedSection).toContainText("继续");
  await expect(continuedSection).toContainText("已在新回合继续处理旧任务上下文");

  const dividerColors: string[] = [];
  for (const mode of ["light", "dark", "black"] as const) {
    await page.evaluate(
      (themeMode) => (window as any).__CODELY_E2E__?.setThemeMode?.(themeMode),
      mode,
    );
    await expect(page.locator("html")).toHaveAttribute("data-theme", mode);
    const color = await page.getByTestId("turn-boundary-divider").evaluate(
      (node) => getComputedStyle(node).backgroundColor,
    );
    expect(color).not.toBe("rgba(0, 0, 0, 0)");
    expect(color).not.toBe("transparent");
    dividerColors.push(color);
  }
  expect(new Set(dividerColors).size).toBeGreaterThan(1);
});

test("workspace-external local file reads request approval before ingesting and reading", async ({
  page,
}) => {
  await page.goto("/?e2eScenario=local-file-read-approval");

  const sent = await page.evaluate(() =>
    (window as any).__CODELY_E2E__?.sendCloudMessage?.(
      "请读取外部日志 /tmp/e2e-outside-main-debug.log。",
    ),
  );
  expect(sent).toBe(true);

  await expect
    .poll(async () =>
      page.evaluate(() => {
        const snapshot = (window as any).__CODELY_E2E__?.getSnapshot?.();
        const probe = (window as any).__CLOUD_TOOL_PROTOCOL_TEST__;
        const toolNames = snapshot?.toolNames || [];
        const readIndex = toolNames.lastIndexOf("read_file");
        const request = snapshot?.activeActionRequest;
        return {
          agentStatus: snapshot?.agentStatus,
          pendingRead:
            readIndex >= 0
              ? {
                  target: snapshot?.toolTargets?.[readIndex],
                  status: snapshot?.toolStatuses?.[readIndex],
                }
              : null,
          exactActionRequest:
            request?.kind === "tool_permission" &&
            request?.status === "pending" &&
            request?.toolName === "read_file" &&
            request?.target === "/tmp/e2e-outside-main-debug.log" &&
            request?.taskId === snapshot?.pendingReviewTaskId &&
            typeof request?.toolCallId === "string" &&
            request.toolCallId.length > 0,
          ingested: probe?.ingestedAttachments || [],
          readFileCalls: probe?.readFileCalls || [],
        };
      }),
    )
    .toEqual({
      agentStatus: "pending_review",
      pendingRead: {
        target: "/tmp/e2e-outside-main-debug.log",
        status: "pending",
      },
      exactActionRequest: true,
      ingested: [],
      readFileCalls: [],
    });

  await page
    .getByTestId("chat-scroll-container")
    .getByRole("button", { name: "允许执行" })
    .click();

  await expect(
    page.getByText("已读取外部日志，确认包含 LOCAL_FILE_READ_OK。"),
  ).toBeVisible();

  await expect
    .poll(async () =>
      page.evaluate(() => {
        const snapshot = (window as any).__CODELY_E2E__?.getSnapshot?.();
        const probe = (window as any).__CLOUD_TOOL_PROTOCOL_TEST__;
        const toolNames = snapshot?.toolNames || [];
        const readIndex = toolNames.lastIndexOf("read_file");
        return {
          agentStatus: snapshot?.agentStatus,
          readToolStatus:
            readIndex >= 0 ? snapshot?.toolStatuses?.[readIndex] : null,
          activeActionRequest: snapshot?.activeActionRequest,
          pendingReviewTaskId: snapshot?.pendingReviewTaskId,
          resultKind: snapshot?.currentTurnResultKind,
          visibleFinalCount: snapshot?.visibleFinalCount,
          ingested: probe?.ingestedAttachments || [],
          readFileCalls: probe?.readFileCalls || [],
        };
      }),
    )
    .toEqual({
      agentStatus: "idle",
      readToolStatus: "executed",
      activeActionRequest: null,
      pendingReviewTaskId: null,
      resultKind: "success",
      visibleFinalCount: 1,
      ingested: [
        {
          sessionKey: "/tmp/e2e-local-file-read-approval:999506",
          sourcePath: "/tmp/e2e-outside-main-debug.log",
        },
      ],
      readFileCalls: [".MAIN-chat-attachments/outside-main-debug.log"],
    });
});

test("workspace-external local file read rejection fails without ingesting or reading", async ({
  page,
}) => {
  await page.goto("/?e2eScenario=local-file-read-approval");

  const sent = await page.evaluate(() =>
    (window as any).__CODELY_E2E__?.sendCloudMessage?.(
      "请读取外部日志 /tmp/e2e-outside-main-debug.log。",
    ),
  );
  expect(sent).toBe(true);

  await expect
    .poll(async () =>
      page.evaluate(() => {
        const snapshot = (window as any).__CODELY_E2E__?.getSnapshot?.();
        const probe = (window as any).__CLOUD_TOOL_PROTOCOL_TEST__;
        const toolNames = snapshot?.toolNames || [];
        const readIndex = toolNames.lastIndexOf("read_file");
        const request = snapshot?.activeActionRequest;
        return {
          agentStatus: snapshot?.agentStatus,
          pendingRead:
            readIndex >= 0
              ? {
                  target: snapshot?.toolTargets?.[readIndex],
                  status: snapshot?.toolStatuses?.[readIndex],
                }
              : null,
          exactActionRequest:
            request?.kind === "tool_permission" &&
            request?.status === "pending" &&
            request?.toolName === "read_file" &&
            request?.target === "/tmp/e2e-outside-main-debug.log" &&
            request?.taskId === snapshot?.pendingReviewTaskId &&
            typeof request?.toolCallId === "string" &&
            request.toolCallId.length > 0,
          ingested: probe?.ingestedAttachments || [],
          readFileCalls: probe?.readFileCalls || [],
        };
      }),
    )
    .toEqual({
      agentStatus: "pending_review",
      pendingRead: {
        target: "/tmp/e2e-outside-main-debug.log",
        status: "pending",
      },
      exactActionRequest: true,
      ingested: [],
      readFileCalls: [],
    });

  await page
    .getByTestId("chat-scroll-container")
    .getByRole("button", { name: "拒绝" })
    .click();
  await expect(
    page
      .getByTestId("chat-scroll-container")
      .getByText(/未读取.*e2e-outside-main-debug\.log.*本轮未导入或读取该文件/),
  ).toBeVisible();

  await expect
    .poll(async () =>
      page.evaluate(() => {
        const snapshot = (window as any).__CODELY_E2E__?.getSnapshot?.();
        const probe = (window as any).__CLOUD_TOOL_PROTOCOL_TEST__;
        const toolNames = snapshot?.toolNames || [];
        const readIndex = toolNames.lastIndexOf("read_file");
        const visibleText = document.body.innerText;
        return {
          agentStatus: snapshot?.agentStatus,
          readToolStatus:
            readIndex >= 0 ? snapshot?.toolStatuses?.[readIndex] : null,
          activeActionRequest: snapshot?.activeActionRequest,
          pendingReviewTaskId: snapshot?.pendingReviewTaskId,
          resultKind: snapshot?.currentTurnResultKind,
          visibleFinalCount: snapshot?.visibleFinalCount,
          canonicalOutcome: (snapshot?.agentTexts || []).some(
            (text: string) =>
              text.includes("未读取 `/tmp/e2e-outside-main-debug.log`") &&
              text.includes("本轮未导入或读取该文件"),
          ),
          rawErrorVisible:
            /TOOL_ERROR|RUNTIME_V2_PERMISSION_|Reading a local file outside the workspace requires/i.test(
              visibleText,
            ),
          ingested: probe?.ingestedAttachments || [],
          readFileCalls: probe?.readFileCalls || [],
        };
      }),
    )
    .toEqual({
      agentStatus: "idle",
      readToolStatus: "rejected",
      activeActionRequest: null,
      pendingReviewTaskId: null,
      resultKind: "blocked",
      visibleFinalCount: 1,
      canonicalOutcome: true,
      rawErrorVisible: false,
      ingested: [],
      readFileCalls: [],
    });
});
