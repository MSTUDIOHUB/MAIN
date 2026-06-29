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
    let approvedPlanReplayRequests = 0;
    const requests: Array<{ hasTools: boolean; body: string }> = [];
    const readFileCalls: string[] = [];
    const writeFileCalls: string[] = [];
    const runCommandCalls: string[] = [];
    const listDirectoryCalls: string[] = [];
    const queryTabularCalls: Array<{ path: string; selectColumns?: unknown; limit?: unknown }> = [];
    const ingestedAttachments: Array<{ sessionKey: string; sourcePath: string }> = [];
    let localPlanClosureRequests = 0;
    const memoryFiles = new Map<string, { content: string; modifiedMs: number }>();
    const getMemoryFile = (path: string) => memoryFiles.get(String(path || "").replace(/\\/g, "/").replace(/^\.\//, ""));
    const setMemoryFile = (path: string, content: string) => {
      memoryFiles.set(String(path || "").replace(/\\/g, "/").replace(/^\.\//, ""), {
        content,
        modifiedMs: Date.now(),
      });
    };
    setMemoryFile("src/main.js", [
      "import { initEditor } from './components/editor.js';",
      "",
      "const root = document.getElementById('app');",
      "",
      "export function boot() {",
      "  root.innerHTML = '<div class=\"editor-shell\"></div>';",
      "  initEditor(root.querySelector('.editor-shell'));",
      "}",
      "",
      "boot();",
      "",
    ].join("\n"));
    setMemoryFile("src/components/editor.js", [
      "export function initEditor(container) {",
      "  container.innerHTML = '<textarea aria-label=\"Markdown editor\"></textarea>';",
      "}",
      "",
    ].join("\n"));
    setMemoryFile("src-tauri/src/main.rs", [
      "fn main() {",
      "    tauri::Builder::default()",
      "        .run(tauri::generate_context!())",
      "        .expect(\"error while running tauri application\");",
      "}",
      "",
    ].join("\n"));

    (window as any).__CLOUD_TOOL_PROTOCOL_TEST__ = {
      requests,
      readFileCalls,
      writeFileCalls,
      runCommandCalls,
      listDirectoryCalls,
      queryTabularCalls,
      ingestedAttachments,
      get fallbackNoToolRequests() {
        return fallbackNoToolRequests;
      },
      get pseudoToolRecoveryRequests() {
        return pseudoToolRecoveryRequests;
      },
      get localPlanClosureRequests() {
        return localPlanClosureRequests;
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
      if (cmd === "shell_permission_preflight") {
        const command = String(args?.command ?? "");
        return {
          command,
          decision: "allow",
          source: "e2e",
          segmentDecisions: [
            {
              command,
              decision: "allow",
              riskLevel: "low",
            },
          ],
          riskLevel: "low",
          requiresApproval: false,
        };
      }
      if (cmd === "list_project_sessions" || cmd === "rebuild_project_sessions_index") return [];
      if (cmd === "save_project_session") return args?.session ?? {};
      if (cmd === "load_project_session") return {};
      if (cmd === "get_file_metadata") {
        const path = String(args?.path ?? "");
        const file = getMemoryFile(path);
        if (file) return { path, sizeBytes: file.content.length, modifiedMs: file.modifiedMs };
        return { path, sizeBytes: 32, modifiedMs: 1 };
      }
      if (cmd === "get_project_skeleton") {
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
        if (path === "src") {
          return [
            { name: "Gameplay", path: "src/Gameplay", is_dir: true },
            { name: "SnakeController.cs", path: "src/SnakeController.cs", is_dir: false },
          ];
        }
        return [];
      }
      if (cmd === "query_tabular_document") {
        const path = String(args?.path ?? "");
        queryTabularCalls.push({
          path,
          selectColumns: args?.selectColumns,
          limit: args?.limit,
        });
        return {
          path,
          columns: ["课程名称"],
          rows: [{ "课程名称": "MAIN 稳定性课程" }],
          totalRows: 1,
          returnedRows: 1,
        };
      }
      if (cmd === "read_file_window") {
        const path = String(args?.path ?? "");
        const scenario = new URL(window.location.href).searchParams.get("e2eScenario");
        const memoryFile = getMemoryFile(path);
        if (scenario === "approved-plan-execution-replay" && memoryFile) {
          readFileCalls.push(path);
          const lines = memoryFile.content.split("\n");
          const startLine = Math.max(1, Number(args?.startLine ?? 1) || 1);
          const endLine = Math.min(lines.length, Number(args?.endLine ?? lines.length) || lines.length);
          const selected = lines.slice(startLine - 1, endLine).join("\n");
          return {
            path,
            content: selected,
            startLine,
            endLine,
            totalLines: lines.length,
            totalChars: memoryFile.content.length,
            returnedChars: selected.length,
            truncated: false,
          };
        }
        if (
          (scenario === "local-file-read-approval" || scenario === "global-chat-attachment-read") &&
          path === ".MAIN-chat-attachments/outside-main-debug.log" &&
          args?.workspace === "/tmp/e2e-chat-temp"
        ) {
          readFileCalls.push(path);
          return {
            path,
            content: scenario === "global-chat-attachment-read"
              ? "GLOBAL_ATTACHMENT_READ_OK: debug log line"
              : "LOCAL_FILE_READ_OK: debug log line",
            startLine: 1,
            endLine: 1,
            totalLines: 1,
            totalChars: scenario === "global-chat-attachment-read" ? 42 : 34,
            returnedChars: scenario === "global-chat-attachment-read" ? 42 : 34,
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
          (scenario === "local-file-read-approval" || scenario === "global-chat-attachment-read") &&
          path === ".MAIN-chat-attachments/outside-main-debug.log" &&
          args?.workspace === "/tmp/e2e-chat-temp"
        ) {
          readFileCalls.push(path);
          return scenario === "global-chat-attachment-read"
            ? "GLOBAL_ATTACHMENT_READ_OK: debug log line"
            : "LOCAL_FILE_READ_OK: debug log line";
        }
        const planFiles: Record<string, string> = {
          ".MAIN/plans/requirements.md": [
            "# Requirements",
            "",
            "## 需求",
            "",
            scenario === "approved-plan-execution-replay"
              ? "批准后的计划必须真实修改 MD Viewer 的源码并验证，不能只重复读取文件或口头完成。"
              : "用户要求根据 `.MAIN/plans` 执行时，MAIN 必须恢复计划执行语义，同时暴露执行工具并保留逐项审查。",
            "",
            "## 验收",
            "",
            ...(scenario === "approved-plan-execution-replay"
              ? [
                  "- src/main.js 中出现启动面板标记。",
                  "- 执行 `npm run test:workflow-assets`。",
                ]
              : [
                  "- PlanPanel 显示任务。",
                  "- runtime 工具包含 shell/write。",
                ]),
          ].join("\n"),
          ".MAIN/plans/design.md": [
            "# Design",
            "",
            "## 方案",
            "",
            scenario === "approved-plan-execution-replay"
              ? "修改 `src/main.js` 的启动 UI，添加空白编辑器的开始面板，然后运行验证命令。"
              : "在发送前 hydrate `.MAIN/plans`，conversation intent 保持 plan，runtime intent 使用 execute。",
            "",
            "## 验证",
            "",
            ...(scenario === "approved-plan-execution-replay"
              ? [
                  "- `src/main.js` 必须有真实文件 diff。",
                  "- `npm run test:workflow-assets` 成功。",
                ]
              : [
                  "- 下一轮模型请求包含 run_command。",
                  "- 工具调用进入 ActionCard 审查。",
                ]),
          ].join("\n"),
          ".MAIN/plans/tasks.md": [
            "# Tasks",
            "",
            scenario === "approved-plan-execution-replay"
              ? "- [ ] 修改 `src/main.js` 添加启动面板 — 证据: file:src/main.js"
              : "- [ ] 运行计划执行验证命令 `npm run test:workflow-assets` — 证据: cmd:npm run test:workflow-assets",
            ...(scenario === "approved-plan-execution-replay"
              ? ["- [ ] 运行 `npm run test:workflow-assets` — 证据: cmd:npm run test:workflow-assets"]
              : []),
          ].join("\n"),
        };
        if (
          (scenario === "existing-plan-folder-execute" || scenario === "approved-plan-execution-no-tool" || scenario === "approved-plan-execution-replay") &&
          Object.prototype.hasOwnProperty.call(planFiles, path)
        ) {
          readFileCalls.push(path);
          return planFiles[path];
        }
        const memoryFile = getMemoryFile(path);
        if (scenario === "approved-plan-execution-replay" && memoryFile) {
          readFileCalls.push(path);
          return memoryFile.content;
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

      if (cmd === "write_file") {
        const path = String(args?.path ?? "");
        const content = String(args?.content ?? "");
        writeFileCalls.push(path);
        setMemoryFile(path, content);
        return null;
      }

      if (cmd === "run_command") {
        const command = String(args?.command ?? "");
        runCommandCalls.push(command);
        return {
          command,
          exitCode: 0,
          stdout: "workflow asset tests passed",
          stderr: "",
          durationMs: 12,
          timedOut: false,
        };
      }

      if (cmd === "proxy_request") {
        const scenario = new URL(window.location.href).searchParams.get("e2eScenario");
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

        if (scenario === "progress-narration-tool-flow") {
          if (readFileCalls.includes("README.md")) {
            return JSON.stringify({
              output_text: "已确认 README.md 包含 fallback-ok，进度展示链路没有暴露原始工具协议。",
            });
          }
          return JSON.stringify({
            output_text: [
              "<tool_use>",
              "<tool>read_file</tool>",
              "<parameter name=\"path\">README.md</parameter>",
              "</tool_use>",
            ].join("\n"),
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

        if (scenario === "plan-operation-approval-reuse") {
          if (readFileCalls.includes("README.md")) {
            return JSON.stringify({
              output_text: "已进入执行模式继续处理，没有再次请求操作审批。",
            });
          }
          if (body.includes("我批准按上面的方案开始真实操作")) {
            return JSON.stringify({
              output_text: [
                "我会复用刚才的方案直接执行验证。",
                "<tool_use>",
                "<tool>read_file</tool>",
                "<parameter name=\"path\">README.md</parameter>",
                "</tool_use>",
              ].join("\n"),
            });
          }
          return JSON.stringify({
            output_text: [
              "我会先定位 CSV 导入和图表渲染链路，然后执行修复。",
              "<user_options>",
              "<option action=\"approve_operation_once\" value=\"我批准按上面的方案开始真实操作，请复用上一轮方案，不要重新规划，直接执行并验证\">批准执行本轮操作</option>",
              "<option action=\"adjust_plan\" value=\"继续调整上面的方案，暂不执行真实操作\">继续调整方案</option>",
              "<option action=\"cancel_operation\" value=\"取消上面的执行操作，本轮到此为止\">取消操作</option>",
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

        if (scenario === "operation-approval-natural-flow") {
          return JSON.stringify({
            output_text: [
              "我会按批准开始真实修复。",
              "<tool_use>",
              "<tool>write_file</tool>",
              "<parameter name=\"path\">src/fix-proof.txt</parameter>",
              "<parameter name=\"content\">fixed</parameter>",
              "</tool_use>",
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
              "<option>先继续调整方案</option>",
              "</user_options>",
            ].join("\n"),
          });
        }

        if (scenario === "unity-mcp-options-priority") {
          if (body.includes("请继续执行轻量读取路径")) {
            return JSON.stringify({
              output_text: "已收到选择，按轻量读取路径继续。",
            });
          }
          return JSON.stringify({
            output_text: [
              "Unity 任务开始前，需要你先确认执行分支。",
              "<user_options>",
              "<option>请继续执行轻量读取路径</option>",
              "<option>先停在方案评审阶段</option>",
              "</user_options>",
            ].join("\n"),
          });
        }

        if (scenario === "unity-tool-code-compat") {
          if (body.includes("src/SnakeController.cs")) {
            return JSON.stringify({
              output_text: "已读取 src 目录，定位到 SnakeController.cs，可继续细化排查。",
            });
          }
          if (body.includes("非标准工具格式") || body.includes("not an executable tool call")) {
            return JSON.stringify({
              output_text: [
                "我改用标准 XML 工具调用。",
                "<tool_use>",
                "<tool>list_directory</tool>",
                "<parameter name=\"path\">src</parameter>",
                "</tool_use>",
              ].join("\n"),
            });
          }
          return JSON.stringify({
            output_text: [
              "我先读取 src 目录。",
              "<tool_code>",
              "list_directory(\"src\")",
              "</tool_code>",
            ].join("\n"),
          });
        }

        if (scenario === "unity-no-error-routing") {
          if (body.includes("仍缺少必需的 `read_console`") || body.includes("auto-fallbacked to local diagnostics")) {
            return JSON.stringify({
              output_text: "UNEXPECTED_READ_CONSOLE_FALLBACK",
            });
          }
          if (body.includes("fallback-ok")) {
            return JSON.stringify({
              output_text: "已按行为问题路径继续，没有强制 console 诊断。",
            });
          }
          return JSON.stringify({
            output_text: [
              "我先走行为问题排查路径，读取 README 上下文。",
              "<tool_use>",
              "<tool>read_file</tool>",
              "<parameter name=\"path\">README.md</parameter>",
              "</tool_use>",
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

        if (scenario === "malformed-tool-use-plan") {
          if (queryTabularCalls.length > 0) {
            return JSON.stringify({
              output_text: [
                "# Design",
                "",
                "## 目标与约束",
                "- 目标：基于 orders.csv 设计一个稳定的数据分析自动化流程，避免 Plan 阶段卡在工具协议恢复上。",
                "- 约束：批准前只生成 `.MAIN/plans/design.md`，不生成 tasks.md，也不修改源码或业务数据。",
                "",
                "## 当前发现",
                "- 已通过表格查询读取课程名称样例，确认数据中包含 `MAIN 稳定性课程`。",
                "- 本轮只需要收敛设计方案，后续执行阶段再补充任务清单和验证命令。",
                "",
                "## 方案",
                "- 入口接收用户选择的 CSV 文件路径，并优先调用表格查询工具抽取课程、订单、金额等关键字段。",
                "- 设计层将查询结果整理成指标口径、异常检查和报表输出三部分，保持每一步都可追踪。",
                "",
                "## 影响文件与接口",
                "- 计划文件：`.MAIN/plans/design.md`。",
                "- 工具接口：`query_tabular_document` 负责筛选和聚合，必要时再由执行阶段补充 `run_command` 验证。",
                "",
                "## 执行顺序",
                "1. 固化数据字段和指标口径。",
                "2. 设计查询和聚合步骤。",
                "3. 明确报表输出结构和人工复核点。",
                "",
                "## 数据流与验证",
                "- 数据流：CSV 输入 -> 表格查询 -> 指标汇总 -> 报表草稿。",
                "- 验证：抽样核对课程名称、订单数和金额聚合结果，确保异常行可以回溯到原始 CSV。",
                "",
                "## 风险与后续确认",
                "- 风险：列名变化会导致查询条件失效，需要执行阶段增加列名兼容检查。",
                "- 后续确认：执行前由用户选择输出格式；默认先生成 Markdown 报告草稿。",
              ].join("\n"),
            });
          }
          return JSON.stringify({
            output_text: [
              "<tool_use>",
              "<parameter name=\"path\">orders.csv</parameter>",
              "<parameter name=\"select_columns\">课程名称</parameter>",
              "<parameter name=\"limit\">20</parameter>",
              "<parameter name=\"tool\">query_tabular_document</parameter>",
              "</tool_use>",
            ].join("\n"),
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

        if (scenario === "approved-plan-execution-no-tool") {
          return JSON.stringify({
            output_text: "继续执行下一步。",
          });
        }

        if (scenario === "approved-plan-execution-replay") {
          approvedPlanReplayRequests += 1;
          const step = approvedPlanReplayRequests;
          if (step === 1) {
            return JSON.stringify({
              output_text: [
                "我先读取需要修改的启动入口。",
                "<tool_use>",
                "<tool>read_file</tool>",
                "<parameter name=\"path\">src/main.js</parameter>",
                "</tool_use>",
              ].join("\n"),
            });
          }
          if (step === 2) {
            return JSON.stringify({
              output_text: [
                "我会尝试打补丁。",
                "<tool_use>",
                "<tool>apply_patch</tool>",
                "<parameter name=\"patch\">*** Begin Patch\n*** Update File: src/main.js\n@@\n-  root.innerHTML = '&lt;div class=\"missing-old-shell\"&gt;&lt;/div&gt;';\n+  root.innerHTML = '&lt;div class=\"start-panel\" data-e2e=\"approved-plan-execution-replay-marker\"&gt;&lt;/div&gt;';\n*** End Patch</parameter>",
                "</tool_use>",
              ].join("\n"),
            });
          }
          return JSON.stringify({
            output_text: [
              "我需要再次查看同一个文件。",
              "<tool_use>",
              "<tool>read_file</tool>",
              "<parameter name=\"path\">src/main.js</parameter>",
              "</tool_use>",
            ].join("\n"),
          });
        }

        if (scenario === "ordinary-continue-new-turn") {
          if (readFileCalls.includes("README.md")) {
            return JSON.stringify({
              output_text: "已在新回合继续处理旧任务上下文。",
            });
          }
          return JSON.stringify({
            output_text: [
              "我会从上一轮暂停点继续，并先复核 README。",
              "<tool_use>",
              "<tool>read_file</tool>",
              "<parameter name=\"path\">README.md</parameter>",
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

        if (scenario === "global-chat-tool-scope") {
          return JSON.stringify({
            output_text: "全局聊天未使用项目工具。",
          });
        }

        if (scenario === "global-chat-attachment-read") {
          if (body.includes("GLOBAL_ATTACHMENT_READ_OK")) {
            return JSON.stringify({
              output_text: "已读取附件，确认包含 GLOBAL_ATTACHMENT_READ_OK。",
            });
          }
          return JSON.stringify({
            output_text: [
              "我会读取这份聊天附件。",
              "<tool_use>",
              "<tool>read_file</tool>",
              "<parameter name=\"path\">.MAIN-chat-attachments/outside-main-debug.log</parameter>",
              "</tool_use>",
            ].join("\n"),
          });
        }

        return JSON.stringify({ output_text: "ok" });
      }

      return null;
    };

    const nativeFetch = window.fetch.bind(window);
    window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const scenario = new URL(window.location.href).searchParams.get("e2eScenario");
      const url = typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
      if (
        scenario !== "local-plan-slow-first-token" &&
        scenario !== "plan-closure-guard-empty"
      ) {
        return nativeFetch(input, init);
      }
      if (!url.includes("/api/chat")) {
        return nativeFetch(input, init);
      }

      const encoder = new TextEncoder();
      if (scenario === "plan-closure-guard-empty") {
        localPlanClosureRequests += 1;
        const bodyText = typeof init?.body === "string" ? init.body : "";
        const hasDesignClosurePrompt =
          bodyText.includes("生成可审阅、可执行的正式设计方案") ||
          bodyText.includes("Generate a reviewable, actionable design now");
        const designContent = [
          "# Design",
          "",
          "## 用户目标与约束",
          "- 目标：基于 orders.csv 设计课程销售数据分析自动化流程。",
          "- 约束：批准前只写 `.MAIN/plans/design.md`，不生成 tasks.md，不修改源码或业务数据。",
          "",
          "## 当前真实发现",
          "- 已查询 orders.csv 的课程名称列，确认数据源可以通过表格工具读取。",
          "- 关键字段包含课程名称，后续设计围绕课程、订单金额、购买时间等指标口径展开。",
          "",
          "## 拟定方案",
          "- 导入 CSV 后先识别字段、缺失值和金额/时间格式。",
          "- 生成课程维度销售排行、趋势摘要和异常订单提示。",
          "- 在 Mac 轻量界面中提供文件选择、概览卡片、表格明细和导出入口。",
          "",
          "## 影响文件与接口",
          "- 计划文件：`.MAIN/plans/design.md`。",
          "- 执行阶段再确定 Swift/前端源码文件和 CSV 读取接口。",
          "",
          "## 执行顺序",
          "1. 明确 CSV 字段映射和指标口径。",
          "2. 实现 CSV 解析与字段校验。",
          "3. 实现课程销售聚合和趋势计算。",
          "4. 完成 Mac 轻量界面和导出验证。",
          "",
          "## 数据流与控制流",
          "- 数据流：用户选择 orders.csv -> 字段校验 -> 聚合计算 -> 图表/表格展示 -> 导出。",
          "- 控制流：设计审批 -> 生成 tasks.md -> 按任务实现 -> 运行验证。",
          "",
          "## 风险取舍",
          "- CSV 字段命名可能变化，需要执行阶段做字段别名兼容。",
          "- 第一版优先本地轻量分析，不引入数据库同步。",
          "",
          "## 验证方式",
          "- 使用 orders.csv 样本核对课程销售聚合结果。",
          "- 验证空文件、缺字段、金额格式异常的提示。",
          "",
          "## 开放问题",
          "- 是否需要固定导出 Excel，还是先导出 CSV/Markdown 摘要。",
        ].join("\n");
        const content = queryTabularCalls.length === 0
          ? [
              "<tool_use>",
              "<tool>query_tabular_document</tool>",
              "<parameter name=\"path\">orders.csv</parameter>",
              "<parameter name=\"select_columns\">课程名称</parameter>",
              "<parameter name=\"limit\">20</parameter>",
              "</tool_use>",
            ].join("\n")
          : hasDesignClosurePrompt
            ? [
                "<tool_use>",
                "<tool>write_file</tool>",
                "<parameter name=\"path\">.MAIN/plans/design.md</parameter>",
                `<parameter name=\"content\">${designContent}</parameter>`,
                "</tool_use>",
              ].join("\n")
            : "";

        return new Response(new ReadableStream({
          start(controller) {
            controller.enqueue(encoder.encode(`${JSON.stringify({ message: { content }, done: false })}\n`));
            controller.enqueue(encoder.encode(`${JSON.stringify({ done: true })}\n`));
            controller.close();
          },
        }), {
          status: 200,
          headers: { "Content-Type": "application/x-ndjson" },
        });
      }

      const designText = [
        "# Design",
        "",
        "## 目标与约束",
        "- 目标：验证本地 Plan 模式慢首 token 时不会被 125 秒硬看门狗中断。",
        "- 约束：批准前只允许写入 `.MAIN/plans/design.md`，不生成 tasks.md，也不修改项目源码。",
        "",
        "## 当前发现",
        "- 本地 Ollama/Qwen 首轮可能长时间没有可见 token，但请求仍可能继续完成。",
        "- UI 应显示等待提示，底层请求必须保持运行，直到模型返回正文或用户手动停止。",
        "",
        "## 方案",
        "- 本地 Plan+xml 请求关闭 no-visible-token hard timeout，只保留 120 秒 UI 提示。",
        "- 云端请求继续保留 hard timeout，防止网关连接长期挂死。",
        "",
        "## 影响文件与接口",
        "- 计划文件：`.MAIN/plans/design.md`。",
        "- 运行接口：不改变工具 schema，只改变本地 Plan 请求的 watchdog 策略。",
        "",
        "## 执行顺序",
        "1. 判断 activeProfile 是否为 local。",
        "2. local Plan+xml 只显示等待提示，不 abort 请求。",
        "3. 模型返回设计正文后自动 materialize 为 design.md。",
        "",
        "## 数据流与验证",
        "- 数据流：用户 Plan 请求 -> 本地模型慢首 token -> UI notice -> 模型正文 -> design.md。",
        "- 验证：日志不出现 `STREAM_NO_VISIBLE_TOKEN_TIMEOUT` 或 `plan_stage_waiting_for_design`。",
        "",
        "## 风险与后续确认",
        "- 风险：本地模型如果永久无响应，需要用户手动停止。",
        "- 后续确认：保留停止按钮和状态提示，避免用户误以为应用卡死。",
      ].join("\n");

      return new Response(new ReadableStream({
        start(controller) {
          const abort = () => {
            controller.error(new DOMException("Aborted", "AbortError"));
          };
          if (init?.signal?.aborted) {
            abort();
            return;
          }
          init?.signal?.addEventListener("abort", abort, { once: true });
          window.setTimeout(() => {
            if (init?.signal?.aborted) return;
            controller.enqueue(encoder.encode(`${JSON.stringify({ message: { content: designText }, done: false })}\n`));
            controller.enqueue(encoder.encode(`${JSON.stringify({ done: true })}\n`));
            controller.close();
          }, 130_000);
        },
      }), {
        status: 200,
        headers: { "Content-Type": "application/x-ndjson" },
      });
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
          noToolRequestsInExpectedRange:
            (probe?.fallbackNoToolRequests ?? 0) >= 3 &&
            (probe?.fallbackNoToolRequests ?? 0) <= 5,
        };
      }),
    )
    .toEqual({
      attemptedNativeTools: true,
      retriedWithoutNativeTools: true,
      readFileCalls: ["README.md"],
      noToolRequestsInExpectedRange: true,
    });
});

test("tool flow shows progress narration without exposing raw protocol", async ({ page }) => {
  await page.goto("/?e2eScenario=progress-narration-tool-flow");

  const sent = await page.evaluate(() =>
    (window as any).__CODELY_E2E__?.sendCloudMessage?.("请读取 README.md 并确认是否包含 fallback-ok。"),
  );
  expect(sent).toBe(true);

  await expect(page.getByText("已确认 README.md 包含 fallback-ok")).toBeVisible();
  await expect(page.locator("body")).not.toContainText("<tool_use>");
  await expect(page.locator("body")).not.toContainText("\"toolName\"");
  await expect(page.locator("body")).not.toContainText("<analysis>");
  const archiveToggle = page.getByTestId("turn-process-archive-toggle");
  await expect(archiveToggle).toBeVisible();
  await expect(archiveToggle).toHaveAttribute("aria-expanded", "false");
  await archiveToggle.click();
  await expect(page.getByTestId("turn-archive-step").filter({ hasText: "README.md" })).toBeVisible();
  await expect(page.getByTestId("read-context-group-summary")).toHaveCount(0);
});

test("reply options pause before mixed XML tool calls and continue from the source turn", async ({ page }) => {
  await page.goto("/?e2eScenario=reply-options-tool-pause");

  const sent = await page.evaluate(() =>
    (window as any).__CODELY_E2E__?.sendCloudMessage?.("请检查后让我选择下一步。"),
  );
  expect(sent).toBe(true);

  await expect(page.getByTestId("execution-capsule-awaiting-choice")).toBeVisible();
  await expect(page.getByTestId("execution-capsule-reply-option-0")).toContainText("保守方案");

  await expect
    .poll(async () =>
      page.evaluate(() => {
        const snapshot = (window as any).__CODELY_E2E__?.getSnapshot?.();
        const probe = (window as any).__CLOUD_TOOL_PROTOCOL_TEST__;
        return {
          status: snapshot?.currentTurnStatus,
          optionBlockCount: snapshot?.optionBlockCount,
          progressBlockCount: snapshot?.progressBlockCount,
          readFileCalls: probe?.readFileCalls?.length ?? -1,
        };
      }),
    )
    .toEqual({
      status: "awaiting_input",
      optionBlockCount: 1,
      progressBlockCount: 0,
      readFileCalls: 0,
    });

  await page.getByTestId("execution-capsule-reply-option-0").click();
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

test("plan executable reply options are ignored when the same turn has tool calls", async ({ page }) => {
  await page.goto("/?e2eScenario=plan-operation-approval-reuse");

  const sent = await page.evaluate(() =>
    (window as any).__CODELY_E2E__?.sendCloudMessage?.("请修复 CSV 导入后图表不显示。"),
  );
  expect(sent).toBe(true);

  await expect
    .poll(async () =>
      page.evaluate(() => {
        const snapshot = (window as any).__CODELY_E2E__?.getSnapshot?.();
        const probe = (window as any).__CLOUD_TOOL_PROTOCOL_TEST__;
        return {
          status: snapshot?.currentTurnStatus,
          currentTurnIntent: snapshot?.currentTurnIntent,
          optionBlockCount: snapshot?.optionBlockCount,
          archivedOptionCount: snapshot?.archivedOptionCount,
          readFileCalls: probe?.readFileCalls ?? [],
          hasFinalText: (snapshot?.agentTexts || []).some((text: string) =>
            String(text || "").includes("已进入执行模式继续处理"),
          ),
        };
      }),
    )
    .toEqual({
      status: "stopped_no_action",
      currentTurnIntent: "plan",
      archivedOptionCount: 0,
      optionBlockCount: 0,
      readFileCalls: ["README.md"],
      hasFinalText: true,
    });
});

test("unity first-iteration fallback does not override explicit reply options", async ({ page }) => {
  await page.goto("/?e2eScenario=unity-mcp-options-priority");

  const sent = await page.evaluate(() =>
    (window as any).__CODELY_E2E__?.sendCloudMessage?.("请在 Unity 场景下先给我可点击选项。"),
  );
  expect(sent).toBe(true);

  await expect(page.getByTestId("execution-capsule-awaiting-choice")).toBeVisible();
  await expect(page.getByTestId("execution-capsule-reply-option-0")).toContainText("继续执行轻量读取路径");

  await expect
    .poll(async () =>
      page.evaluate(() => {
        const snapshot = (window as any).__CODELY_E2E__?.getSnapshot?.();
        const probe = (window as any).__CLOUD_TOOL_PROTOCOL_TEST__;
        return {
          status: snapshot?.currentTurnStatus,
          optionBlockCount: snapshot?.optionBlockCount,
          readFileCalls: probe?.readFileCalls?.length ?? -1,
          requestCountInExpectedRange:
            (probe?.requests?.length ?? 0) >= 1 &&
            (probe?.requests?.length ?? 0) <= 2,
        };
      }),
    )
    .toEqual({
      status: "awaiting_input",
      optionBlockCount: 1,
      readFileCalls: 0,
      requestCountInExpectedRange: true,
    });
});

test("unity tool_code wrapper is recovered into executable flow instead of idle stop", async ({ page }) => {
  await page.goto("/?e2eScenario=unity-tool-code-compat");

  const sent = await page.evaluate(() =>
    (window as any).__CODELY_E2E__?.sendCloudMessage?.("请在 Unity 项目里先读取 src 目录定位脚本入口。"),
  );
  expect(sent).toBe(true);

  await expect(page.getByText("已读取 src 目录，定位到 SnakeController.cs，可继续细化排查。")).toBeVisible();
  await expect(page.getByText("UNEXPECTED_READ_CONSOLE_FALLBACK")).toHaveCount(0);

  await expect
    .poll(async () =>
      page.evaluate(() => {
        const snapshot = (window as any).__CODELY_E2E__?.getSnapshot?.();
        const probe = (window as any).__CLOUD_TOOL_PROTOCOL_TEST__;
        const listDirectoryCalls = probe?.listDirectoryCalls || [];
        return {
          status: snapshot?.currentTurnStatus,
          usedListDirectory: listDirectoryCalls.includes("src"),
          requestCountInExpectedRange:
            (probe?.requests?.length ?? 0) >= 2 &&
            (probe?.requests?.length ?? 0) <= 3,
        };
      }),
    )
    .toEqual({
      status: "done",
      usedListDirectory: true,
      requestCountInExpectedRange: true,
    });
});

test("unity no-error behavior route does not trigger forced read_console fallback", async ({ page }) => {
  await page.goto("/?e2eScenario=unity-no-error-routing");

  const sent = await page.evaluate(() =>
    (window as any).__CODELY_E2E__?.sendCloudMessage?.("Unity 没有报错，但蛇没有自动移动，请先排查行为问题。"),
  );
  expect(sent).toBe(true);

  await expect(page.getByText("已按行为问题路径继续，没有强制 console 诊断。")).toBeVisible();
  await expect(page.getByText("UNEXPECTED_READ_CONSOLE_FALLBACK")).toHaveCount(0);

  await expect
    .poll(async () =>
      page.evaluate(() => {
        const snapshot = (window as any).__CODELY_E2E__?.getSnapshot?.();
        const probe = (window as any).__CLOUD_TOOL_PROTOCOL_TEST__;
        const requests = probe?.requests || [];
        const forcedConsoleFallbackSeen = requests.some((request: any) =>
          String(request.body || "").includes("仍缺少必需的 `read_console`") ||
          String(request.body || "").includes("auto-fallbacked to local diagnostics"),
        );
        return {
          status: snapshot?.currentTurnStatus,
          readFileCalls: probe?.readFileCalls || [],
          forcedConsoleFallbackSeen,
        };
      }),
    )
    .toEqual({
      status: "done",
      readFileCalls: ["README.md"],
      forcedConsoleFallbackSeen: false,
    });
});

test("execute quick reply switches a respond turn to execute runtime and keeps tool review", async ({ page }) => {
  await page.goto("/?e2eScenario=execute-quick-reply-runtime");

  const sent = await page.evaluate(() =>
    (window as any).__CODELY_E2E__?.sendCloudMessage?.("请检查部署方式并让我选择下一步。"),
  );
  expect(sent).toBe(true);

  await expect(page.getByTestId("execution-capsule-awaiting-choice")).toBeVisible();
  await expect(page.getByTestId("execution-capsule-reply-option-0")).toContainText("直接执行部署脚本");

  await page.getByTestId("execution-capsule-reply-option-0").click();

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

test("plain fix request shows operation approval before execute tools", async ({ page }) => {
  await page.goto("/?e2eScenario=operation-approval-natural-flow");

  const sent = await page.evaluate(() =>
    (window as any).__CODELY_E2E__?.sendCloudMessage?.("请修复这个问题。"),
  );
  expect(sent).toBe(true);

  await expect(page.getByTestId("execution-capsule-pending-run-decision")).toBeVisible();
  await expect(page.getByTestId("execution-capsule-intent-option-execute")).toContainText("批准执行本轮操作");

  await expect
    .poll(async () =>
      page.evaluate(() => {
        const snapshot = (window as any).__CODELY_E2E__?.getSnapshot?.();
        const probe = (window as any).__CLOUD_TOOL_PROTOCOL_TEST__;
        return {
          pendingSuggestedIntent: snapshot?.pendingRunDecision?.suggestedIntent ?? null,
          pendingOptionIds: snapshot?.pendingRunDecision?.optionIds ?? [],
          requestCount: probe?.requests?.length ?? 0,
        };
      }),
    )
    .toEqual({
      pendingSuggestedIntent: "execute",
      pendingOptionIds: ["execute", "respond"],
      requestCount: 0,
    });

  await page.getByTestId("execution-capsule-intent-option-execute").click();

  await expect
    .poll(async () =>
      page.evaluate(() => {
        const probe = (window as any).__CLOUD_TOOL_PROTOCOL_TEST__;
        const requests = probe?.requests || [];
        const executionRequest = [...requests]
          .reverse()
          .find((request: any) => request.hasTools && String(request.body || "").includes("[TURN INTENT: EXECUTE]"));
        if (!executionRequest) return null;
        const parsed = JSON.parse(executionRequest.body || "{}");
        const names = (parsed.tools || []).map((tool: any) => tool?.name || tool?.function?.name).filter(Boolean);
        const snapshot = (window as any).__CODELY_E2E__?.getSnapshot?.();
        return {
          hasWriteTool: names.includes("write_file"),
          currentTurnIntent: snapshot?.currentTurnIntent,
          agentStatus: snapshot?.agentStatus,
          hasWriteToolBlock: (snapshot?.toolNames || []).includes("write_file"),
        };
      }),
    )
    .toEqual({
      hasWriteTool: true,
      currentTurnIntent: "execute",
      agentStatus: "pending_review",
      hasWriteToolBlock: true,
    });
});

test("game studio execute reply resumes the source turn with studio workflow tools", async ({ page }) => {
  await page.goto("/?e2eScenario=game-studio-execute-reply-runtime");

  const sent = await page.evaluate(() =>
    (window as any).__CODELY_E2E__?.sendCloudMessage?.("请检查 SnakeController 下一步。"),
  );
  expect(sent).toBe(true);

  await expect(page.getByTestId("execution-capsule-awaiting-choice")).toBeVisible();
  await expect(page.getByTestId("execution-capsule-reply-option-0")).toContainText("立即开始重构并完善");

  await page.getByTestId("execution-capsule-reply-option-0").click();

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
          optionBlockCount: snapshot?.optionBlockCount,
          turns: snapshot?.conversationTurns,
          archivedOptionCount: snapshot?.archivedOptionCount,
          selectedOptions: snapshot?.selectedOptions,
          readFileCalls: probe?.readFileCalls || [],
        };
      }),
    )
    .toEqual({
      hasRead: true,
      hasWrite: true,
      currentTurnIntent: "studio_workflow",
      optionBlockCount: 0,
      turns: 1,
      archivedOptionCount: 1,
      selectedOptions: ["立即开始重构并完善"],
      readFileCalls: ["Assets/Scripts/Entities/SnakeController.cs"],
    });
});

test("pseudo tool call placeholder triggers XML recovery instead of stopping as final text", async ({ page }) => {
  await page.goto("/?e2eScenario=pseudo-tool-call-recovery");

  const sent = await page.evaluate(() =>
    (window as any).__CODELY_E2E__?.sendCloudMessage?.("请读取 README.md。"),
  );
  expect(sent).toBe(true);

  await expect(page.getByText("已读取 README.md，确认包含 fallback-ok。")).toBeVisible();
  await expect(page.getByText("[Tool call: read_file]")).toHaveCount(0);

  await expect
    .poll(async () =>
      page.evaluate(() => {
        const probe = (window as any).__CLOUD_TOOL_PROTOCOL_TEST__;
        return {
          recovered: (probe?.pseudoToolRecoveryRequests ?? 0) >= 1,
          readFileCalls: probe?.readFileCalls || [],
        };
      }),
    )
    .toEqual({
      recovered: true,
      readFileCalls: ["README.md"],
    });
});

test("global chat without explicit files does not expose workspace tools", async ({ page }) => {
  await page.goto("/?e2eScenario=global-chat-tool-scope");

  const sent = await page.evaluate(() =>
    (window as any).__CODELY_E2E__?.sendCloudMessage?.("这是全局聊天，请直接回答一个普通问题。"),
  );
  expect(sent).toBe(true);

  await expect(page.getByTestId("chat-scroll-container").getByText("全局聊天未使用项目工具。")).toBeVisible();

  await expect
    .poll(async () =>
      page.evaluate(() => {
        const probe = (window as any).__CLOUD_TOOL_PROTOCOL_TEST__;
        const requests = probe?.requests || [];
        const latest = [...requests].reverse()[0];
        if (!latest) return null;
        const parsed = JSON.parse(latest.body || "{}");
        const names = (parsed.tools || []).map((tool: any) => tool?.name || tool?.function?.name).filter(Boolean);
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
          leakedWorkspaceTools: names.filter((name: string) => workspaceToolNames.includes(name)),
          listDirectoryCalls: probe?.listDirectoryCalls || [],
          bodyHasGlobalBoundary: String(latest.body || "").includes("当前没有绑定工作区"),
          bodyHasFakeWorkspace: String(latest.body || "").includes("/tmp/e2e-global-chat-tool-scope"),
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

test("global chat with an attachment only exposes attachment read tools", async ({ page }) => {
  await page.goto("/?e2eScenario=global-chat-attachment-read");

  const sent = await page.evaluate(() =>
    (window as any).__CODELY_E2E__?.sendCloudMessage?.("请读取附件并确认标记。"),
  );
  expect(sent).toBe(true);

  await expect(page.getByTestId("chat-scroll-container").getByText("已读取附件，确认包含 GLOBAL_ATTACHMENT_READ_OK。")).toBeVisible();

  await expect
    .poll(async () =>
      page.evaluate(() => {
        const probe = (window as any).__CLOUD_TOOL_PROTOCOL_TEST__;
        const requests = probe?.requests || [];
        const firstWithTools = requests.find((request: any) => request.hasTools);
        if (!firstWithTools) return null;
        const parsed = JSON.parse(firstWithTools.body || "{}");
        const names = (parsed.tools || []).map((tool: any) => tool?.name || tool?.function?.name).filter(Boolean);
        const allowedAttachmentReadTools = [
          "read_file",
          "read_document",
          "analyze_tabular_document",
          "query_tabular_document",
        ];
        return {
          names: [...names].sort(),
          onlyAttachmentReadTools:
            names.length === allowedAttachmentReadTools.length &&
            names.every((name: string) => allowedAttachmentReadTools.includes(name)),
          ingestedAttachments: probe?.ingestedAttachments || [],
          readFileCalls: probe?.readFileCalls || [],
          listDirectoryCalls: probe?.listDirectoryCalls || [],
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
    });
});

test("malformed plan XML tool parameter recovers into tabular query and design artifact", async ({ page }) => {
  await page.goto("/?e2eScenario=malformed-tool-use-plan");

  const sent = await page.evaluate(() =>
    (window as any).__CODELY_E2E__?.sendCloudMessage?.("请基于 orders.csv 生成一个数据分析自动化设计方案。"),
  );
  expect(sent).toBe(true);

  await expect
    .poll(async () =>
      page.evaluate(() => {
        const probe = (window as any).__CLOUD_TOOL_PROTOCOL_TEST__;
        const snapshot = (window as any).__CODELY_E2E__?.getSnapshot?.();
        const logs = JSON.parse(window.localStorage.getItem("main.debugLog.v1") || "[]");
        const joinedAgentText = (snapshot?.agentTexts || []).join("\n");
        const hasLog = (needle: string) => logs.some((entry: { source?: string; message?: string }) =>
          String(entry.source || "").includes(needle) ||
          String(entry.message || "").includes(needle),
        );
        return {
          queryCalls: probe?.queryTabularCalls || [],
          planStage: snapshot?.planStage,
          planArtifactPaths: snapshot?.planArtifactPaths || [],
          hasVisibleProtocolLeak: /<\s*\/?\s*(?:tool_use|parameter)\b/i.test(joinedAgentText),
          stoppedAsEmptyPlan: hasLog("plan_empty_response_checkpoint"),
        };
      }),
    )
    .toEqual({
      queryCalls: [{ path: "orders.csv", selectColumns: "课程名称", limit: 20 }],
      planStage: "design",
      planArtifactPaths: [".MAIN/plans/design.md"],
      hasVisibleProtocolLeak: false,
      stoppedAsEmptyPlan: false,
    });
});

test("plan closure guard prompts model to write actionable design after read-only context", async ({ page }) => {
  await page.goto("/?e2eScenario=plan-closure-guard-empty");

  const sent = await page.evaluate(() =>
    (window as any).__CODELY_E2E__?.sendCloudMessage?.("请基于 orders.csv 生成一个数据分析自动化设计方案。"),
  );
  expect(sent).toBe(true);

  await expect
    .poll(async () =>
      page.evaluate(() => {
        const probe = (window as any).__CLOUD_TOOL_PROTOCOL_TEST__;
        const snapshot = (window as any).__CODELY_E2E__?.getSnapshot?.();
        const logs = JSON.parse(window.localStorage.getItem("main.debugLog.v1") || "[]");
        const hasLog = (needle: string) => logs.some((entry: { source?: string; message?: string }) =>
          String(entry.source || "").includes(needle) ||
          String(entry.message || "").includes(needle),
        );
        return {
          queryCalls: probe?.queryTabularCalls || [],
          agentStatus: snapshot?.agentStatus,
          planStage: snapshot?.planStage,
          planArtifactPaths: snapshot?.planArtifactPaths || [],
          currentTurnStatus: snapshot?.currentTurnStatus,
          hasReviewPrompt: (snapshot?.agentTexts || []).some((text: string) =>
            text.includes("可审批计划文件") || text.includes("停在审批阶段"),
          ),
          hasProcessSummary: (snapshot?.thoughtTexts || []).some((text: string) =>
            text.includes("只读探索") || text.includes("design.md"),
          ),
          closurePrompted: hasLog("plan_design_closure_prompt"),
          reviewReady: hasLog("plan_design_review_ready_after_tool"),
          fallbackMaterialized: hasLog("plan_closure_artifact_materialized"),
          stoppedAsEmptyPlan: hasLog("plan_empty_response_checkpoint"),
        };
      }),
    )
    .toEqual({
      queryCalls: [{ path: "orders.csv", selectColumns: "课程名称", limit: 20 }],
      agentStatus: "pending_review",
      planStage: "design",
      planArtifactPaths: [".MAIN/plans/design.md"],
      currentTurnStatus: "awaiting_approval",
      hasReviewPrompt: true,
      hasProcessSummary: true,
      closurePrompted: true,
      reviewReady: true,
      fallbackMaterialized: false,
      stoppedAsEmptyPlan: false,
    });
});

test("local plan slow first token shows notice without hard-stopping before design", async ({ page }) => {
  await page.clock.install({ time: new Date("2026-05-13T09:00:00Z") });
  await page.goto("/?e2eScenario=local-plan-slow-first-token");

  const sent = await page.evaluate(() =>
    (window as any).__CODELY_E2E__?.sendCloudMessage?.("请为慢首 token 的本地模型生成一个可审批设计方案。"),
  );
  expect(sent).toBe(true);

  await expect
    .poll(async () =>
      page.evaluate(() => (window as any).__CODELY_E2E__?.getSnapshot?.().agentStatus ?? null),
    )
    .toBe("running");

  await page.clock.fastForward(121_000);

  await expect
    .poll(async () =>
      page.evaluate(() => {
        const snapshot = (window as any).__CODELY_E2E__?.getSnapshot?.();
        const logs = JSON.parse(window.localStorage.getItem("main.debugLog.v1") || "[]");
        const hasLog = (needle: string) => logs.some((entry: { source?: string; message?: string }) =>
          String(entry.source || "").includes(needle) ||
          String(entry.message || "").includes(needle),
        );
        return {
          hasNotice: (snapshot?.systemTexts || []).some((text: string) =>
            text.includes("模型已经较长时间没有返回可见流式内容"),
          ),
          noticeOnlyLogged: logs.some((entry: { source?: string }) =>
            entry.source === "store.plan_no_visible_token_notice_only",
          ),
          hardStopped: hasLog("STREAM_NO_VISIBLE_TOKEN_TIMEOUT") || hasLog("plan_stage_waiting_for_design"),
          agentStatus: snapshot?.agentStatus,
        };
      }),
    )
    .toEqual({
      hasNotice: true,
      noticeOnlyLogged: true,
      hardStopped: false,
      agentStatus: "running",
    });

  await page.clock.fastForward(10_000);

  await expect
    .poll(async () =>
      page.evaluate(() => {
        const snapshot = (window as any).__CODELY_E2E__?.getSnapshot?.();
        const logs = JSON.parse(window.localStorage.getItem("main.debugLog.v1") || "[]");
        const hasLog = (needle: string) => logs.some((entry: { source?: string; message?: string }) =>
          String(entry.source || "").includes(needle) ||
          String(entry.message || "").includes(needle),
        );
        return {
          planStage: snapshot?.planStage,
          planArtifactPaths: snapshot?.planArtifactPaths || [],
          currentTurnStatus: snapshot?.currentTurnStatus,
          hardStopped:
            hasLog("STREAM_NO_VISIBLE_TOKEN_TIMEOUT") ||
            hasLog("plan_stage_waiting_for_design") ||
            hasLog("plan_empty_response_checkpoint"),
        };
      }),
    )
    .toEqual({
      planStage: "design",
      planArtifactPaths: [".MAIN/plans/design.md"],
      currentTurnStatus: "awaiting_approval",
      hardStopped: false,
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

test("approved plan execution no-tool replies use execution checkpoint path", async ({ page }) => {
  await page.goto("/?e2eScenario=approved-plan-execution-no-tool");

  const sent = await page.evaluate(() =>
    (window as any).__CODELY_E2E__?.sendCloudMessage?.("根据.MAIN/plans文件夹的内容，继续执行任务。"),
  );
  expect(sent).toBe(true);

  await expect
    .poll(async () =>
      page.evaluate(() => {
        const snapshot = (window as any).__CODELY_E2E__?.getSnapshot?.();
        const logs = JSON.parse(window.localStorage.getItem("main.debugLog.v1") || "[]");
        const hasLog = (needle: string) => logs.some((entry: { source?: string; message?: string }) =>
          String(entry.source || "").includes(needle) ||
          String(entry.message || "").includes(needle),
        );
        return {
          agentStatus: snapshot?.agentStatus,
          planStage: snapshot?.planStage,
          currentTurnStatus: snapshot?.currentTurnStatus,
          hasExecutionReprompt: hasLog("plan_execution_no_tool_reprompt"),
          stoppedGeneric: hasLog("missing_tool_reprompt_limit") || hasLog("missing_tool_loop"),
          hasCheckpoint: (snapshot?.systemTexts || []).some((text: string) =>
            text.includes("计划执行已暂停") || text.includes("remaining_plan_tasks_limit"),
          ),
        };
      }),
    )
    .toEqual({
      agentStatus: "idle",
      planStage: "executing",
      currentTurnStatus: "stopped_no_action",
      hasExecutionReprompt: true,
      stoppedGeneric: false,
      hasCheckpoint: true,
    });
});

test("approved plan execution replay pauses repeated source reads instead of completing or erroring", async ({ page }) => {
  test.setTimeout(45_000);
  await page.goto("/?e2eScenario=approved-plan-execution-replay");

  const sent = await page.evaluate(() =>
    (window as any).__CODELY_E2E__?.sendCloudMessage?.("根据.MAIN/plans文件夹的内容，继续执行任务。"),
  );
  expect(sent).toBe(true);

  await expect
    .poll(async () =>
      page.evaluate(() => {
        const probe = (window as any).__CLOUD_TOOL_PROTOCOL_TEST__;
        const requests = probe?.requests || [];
        const firstWithTools = requests.find((request: any) => request.hasTools);
        const firstToolNames = firstWithTools
          ? (JSON.parse(firstWithTools.body || "{}").tools || [])
              .map((tool: any) => tool?.name || tool?.function?.name)
              .filter(Boolean)
          : [];
        const snapshot = (window as any).__CODELY_E2E__?.getSnapshot?.();
        const logs = JSON.parse(window.localStorage.getItem("main.debugLog.v1") || "[]");
        const hasLog = (needle: string) => logs.some((entry: { source?: string; message?: string }) =>
          String(entry.source || "").includes(needle) ||
          String(entry.message || "").includes(needle),
        );
        const systemTexts = snapshot?.systemTexts || [];
        return {
          agentStatus: snapshot?.agentStatus,
          planStage: snapshot?.planStage,
          currentTurnStatus: snapshot?.currentTurnStatus,
          isPlanApproved: snapshot?.isPlanApproved,
          firstHasReadFile: firstToolNames.includes("read_file"),
          firstHasPatch: firstToolNames.includes("apply_patch") || firstToolNames.includes("replace_in_file"),
          readMainCount: (probe?.readFileCalls || []).filter((path: string) => path === "src/main.js").length,
          sawPatchAttempt: (snapshot?.toolNames || []).includes("apply_patch") ||
            hasLog("workspace_mutation_preflight_blocked"),
          hasRepeatReadPause: hasLog("approved_plan_read_file_repeat_limit") ||
            hasLog("approved_plan_repeated_read_file") ||
            systemTexts.some((text: string) => /重复读取保护|READ_FILE_REPEAT_LIMIT|repeat-read guard|read_file/.test(text)),
          hasAgentLoopError: hasLog("agent_loop_error"),
          completed: snapshot?.planStage === "completed" || snapshot?.currentTurnStatus === "completed_with_changes",
        };
      }),
      { timeout: 35_000 },
    )
    .toEqual({
      agentStatus: "idle",
      planStage: "executing",
      currentTurnStatus: "stopped_no_action",
      isPlanApproved: true,
      firstHasReadFile: true,
      firstHasPatch: true,
      readMainCount: 3,
      sawPatchAttempt: true,
      hasRepeatReadPause: true,
      hasAgentLoopError: false,
      completed: false,
    });
});

test("ordinary continue after stopped execute turn starts a new visible turn", async ({ page }) => {
  await page.goto("/?e2eScenario=ordinary-continue-new-turn");

  const previousTurnId = "e2e-ordinary-continue-previous-turn";
  await expect
    .poll(async () =>
      page.evaluate((turnId) => {
        const snapshot = (window as any).__CODELY_E2E__?.getSnapshot?.();
        const previousTurn = snapshot?.visibleConversationTurns?.find((turn: any) => turn.id === turnId);
        return {
          conversationTurns: snapshot?.conversationTurns,
          currentTurnId: snapshot?.currentTurnId,
          previousStatus: previousTurn?.status,
          previousBlockCount: previousTurn?.blockCount,
        };
      }, previousTurnId),
    )
    .toEqual({
      conversationTurns: 1,
      currentTurnId: previousTurnId,
      previousStatus: "stopped_no_action",
      previousBlockCount: 3,
    });

  const sent = await page.evaluate(() =>
    (window as any).__CODELY_E2E__?.sendCloudMessage?.("继续"),
  );
  expect(sent).toBe(true);

  await expect
    .poll(async () =>
      page.evaluate((turnId) => {
        const snapshot = (window as any).__CODELY_E2E__?.getSnapshot?.();
        const turns = snapshot?.visibleConversationTurns || [];
        const previousTurn = turns.find((turn: any) => turn.id === turnId);
        const newTurn = turns.find((turn: any) => turn.id !== turnId);
        const userBlocks = (snapshot?.taskBlockSummaries || []).filter((block: any) => block.type === "user");
        return {
          conversationTurns: snapshot?.conversationTurns,
          currentTurnIsNew: snapshot?.currentTurnId !== turnId,
          previousBlockCount: previousTurn?.blockCount,
          newTurnIntent: newTurn?.intent,
          continueUserOnNewTurn: userBlocks.filter((block: any) =>
            block.turnId !== turnId && block.content === "继续"
          ).length,
          continueUserOnPreviousTurn: userBlocks.filter((block: any) =>
            block.turnId === turnId && block.content === "继续"
          ).length,
          hasFinalText: (snapshot?.agentTexts || []).some((text: string) =>
            String(text || "").includes("已在新回合继续处理旧任务上下文")
          ),
        };
      }, previousTurnId),
      { timeout: 20_000 },
    )
    .toEqual({
      conversationTurns: 2,
      currentTurnIsNew: true,
      previousBlockCount: 3,
      newTurnIntent: "execute",
      continueUserOnNewTurn: 1,
      continueUserOnPreviousTurn: 0,
      hasFinalText: true,
    });
});

test("ordinary execute repeated read-only loops create a recovery pause instead of an error card", async ({ page }) => {
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
          hasRecoverablePause: systemTexts.some((text: string) => /执行已暂停|Execution paused/.test(text)),
          hasReadOnlyRecoveryGuidance: systemTexts.some((text: string) =>
            /重复只读|复用已读上下文|read-only|reuse read context/i.test(text),
          ),
          currentTurnStatus: snapshot?.currentTurnStatus,
          hasErrorTool: (snapshot?.toolNames || []).includes("Error"),
        };
      }),
      { timeout: 35_000 },
    )
    .toEqual({
      hasRecoverablePause: true,
      hasReadOnlyRecoveryGuidance: true,
      currentTurnStatus: "stopped_no_action",
      hasErrorTool: false,
    });
});

test("approved plan resumes with execute runtime tools while preserving plan turn identity", async ({ page }) => {
  await page.goto("/?e2eScenario=plan-approval-execute-tools");

  await expect(page.getByTestId("execution-capsule-plan-approve")).toBeVisible();
  await page.getByTestId("execution-capsule-plan-approve").click();

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
          currentTurnDisplayIntent: snapshot?.currentTurnDisplayIntent,
          isPlanApproved: snapshot?.isPlanApproved,
        };
      }),
    )
    .toEqual({
      hasWrite: true,
      hasShell: true,
      currentTurnIntent: "plan",
      currentTurnDisplayIntent: "execute",
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
