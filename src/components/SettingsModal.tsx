// @ts-nocheck
import React, { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import { IconSettings, IconClose, IconPlus, IconTrash, IconCloud, IconSave, IconCheck } from "./Icons";
import { type MCPServer, type MCPTool, discoverAllMcpTools, setMcpToolServerMap } from "../lib/mcpClient";
import {
  buildOpenAiResponsesProbeRequestCandidates,
  buildAnthropicRequestBody,
  buildCloudHeaders,
  buildCloudMessagesApiUrl,
  buildCloudModelListCandidates,
  extractAnthropicResponseText,
  extractCloudModelIds,
  extractOpenAiResponseText,
  parseCloudCustomHeaders,
  normalizeCloudApiFormat,
  normalizeCloudProtocol,
  normalizeOpenAiReasoningEffort,
} from "../lib/cloudProtocol";
import { isRetryableCloudErrorMessage } from "../lib/cloudRetry";
import { isProviderCompatibilityErrorMessage } from "../lib/providerCompatibility";
import { clearDebugLog, copyDebugLogToClipboard, readDebugLogSnapshot } from "../lib/debugLog";
import { clearProjectSessions, exportTextFile, spawnPty, writePty } from "../lib/ipc";
import { useAppStore } from "../store/useAppStore";
import {
  createFeishuPairingCode,
  normalizeImAdaptersConfig,
  upsertFeishuPairedUser,
} from "../lib/imAdapters";
import {
  createDefaultCloudConfig,
  createCloudServerConfig,
  normalizeCloudServerState,
} from "../lib/cloudServers";

function buildCloudConnectionFingerprint(server: any, apiFormatOverride?: unknown, modelOverride?: unknown): string {
  if (!server) return "";
  return JSON.stringify({
    endpoint: String(server.endpoint || "").trim(),
    protocol: normalizeCloudProtocol(server.protocol),
    apiFormat: normalizeCloudApiFormat(apiFormatOverride ?? server.apiFormat),
    apiKey: String(server.apiKey || ""),
    customHeaders: String(server.customHeaders || ""),
    model: String(modelOverride ?? server.model ?? "").trim(),
  });
}

function isSameCloudConnectionTarget(current: any, target: any): boolean {
  if (!current || !target) return false;
  return current.id === target.id
    && String(current.endpoint || "") === String(target.endpoint || "")
    && normalizeCloudProtocol(current.protocol) === normalizeCloudProtocol(target.protocol)
    && normalizeCloudApiFormat(current.apiFormat) === normalizeCloudApiFormat(target.apiFormat)
    && String(current.apiKey || "") === String(target.apiKey || "")
    && String(current.customHeaders || "") === String(target.customHeaders || "");
}

// ── MCP Server Management Panel ──────────────────────────────────────────

function McpServerPanel({
  mcpServers,
  setMcpServers,
  mcpDiscoveredTools,
  setMcpDiscoveredTools,
}: {
  mcpServers: MCPServer[];
  setMcpServers: (servers: MCPServer[]) => void;
  mcpDiscoveredTools: MCPTool[];
  setMcpDiscoveredTools: (tools: MCPTool[], toolServerMap: Record<string, string>) => void;
}) {
  const [isDiscovering, setIsDiscovering] = useState(false);
  const [discoverMsg, setDiscoverMsg] = useState<{ text: string; type: 'success' | 'error' } | null>(null);
  // Form state for adding a new server
  const [newName, setNewName] = useState("");
  const [newUrl, setNewUrl] = useState("http://localhost:8000/mcp");

  // Auto-clear discovery message after 5 seconds
  useEffect(() => {
    if (!discoverMsg) return;
    const timer = setTimeout(() => setDiscoverMsg(null), 5000);
    return () => clearTimeout(timer);
  }, [discoverMsg]);

  const handleDiscover = async () => {
    setIsDiscovering(true);
    setDiscoverMsg(null);
    try {
      const { tools, toolServerMap } = await discoverAllMcpTools(mcpServers);
      setMcpDiscoveredTools(tools, toolServerMap);
      setMcpToolServerMap(toolServerMap);
      if (tools.length > 0) {
        setDiscoverMsg({ text: `已发现 ${tools.length} 个工具（来自 ${mcpServers.length} 个服务器）`, type: 'success' });
      } else if (mcpServers.length === 0) {
        setDiscoverMsg({ text: '尚未配置 MCP 服务器', type: 'error' });
      } else {
        setDiscoverMsg({ text: '未发现任何工具，请检查服务器是否在线', type: 'error' });
      }
    } catch (err) {
      setDiscoverMsg({ text: '发现失败: ' + (err instanceof Error ? err.message : String(err)), type: 'error' });
    } finally {
      setIsDiscovering(false);
    }
  };

  const handleAddServer = () => {
    const name = newName.trim();
    const url = newUrl.trim();
    if (!name || !url) return;
    // Prevent duplicate names
    if (mcpServers.some(s => s.name === name)) return;
    setMcpServers([...mcpServers, { name, type: "http", url }]);
    setNewName("");
    setNewUrl("http://localhost:8000/mcp");
  };

  const handleRemoveServer = (name: string) => {
    setMcpServers(mcpServers.filter(s => s.name !== name));
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h3 className="text-[13px] font-bold text-[#a1a1aa] uppercase tracking-wider">MCP 服务器</h3>
        <button
          onClick={handleDiscover}
          disabled={isDiscovering}
          className="px-3 py-1.5 text-[12px] font-bold bg-[#18181b] text-[#a1a1aa] hover:text-white border border-[#27272a] rounded-md transition-colors shrink-0 disabled:opacity-50"
        >
          {isDiscovering ? '扫描中...' : '扫描工具'}
        </button>
      </div>

      <p className="text-[11.5px] text-[#71717a] leading-relaxed">
        配置 MCP (Model Context Protocol) 服务器，使 AI 能够操控外部引擎（如 Unity）。支持 HTTP 传输协议。
      </p>

      {/* ── Server list ────────────────────────────────────── */}
      <div className="space-y-2">
        {mcpServers.length === 0 ? (
          <div className="bg-[#000000] border border-[#27272a] border-dashed rounded-lg p-6 text-center">
            <p className="text-[12px] text-[#71717a]">暂无 MCP 服务器配置</p>
            <p className="text-[11px] text-[#3f3f46] mt-1">点击下方「添加服务器」连接外部引擎</p>
          </div>
        ) : (
          mcpServers.map((server) => (
            <div
              key={server.name}
              className="bg-[#000000] border border-[#27272a] rounded-lg p-4 flex items-center justify-between group"
            >
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="inline-block w-2 h-2 rounded-full bg-[#22c55e] shrink-0" title="HTTP" />
                  <span className="text-[13px] font-bold text-[#e4e4e7] truncate">{server.name}</span>
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-[#18181b] text-[#71717a] border border-[#27272a] uppercase font-mono">HTTP</span>
                </div>
                <p className="text-[11px] text-[#71717a] font-mono mt-1 truncate">{server.url}</p>
              </div>
              <button
                onClick={() => handleRemoveServer(server.name)}
                className="text-[#71717a] hover:text-[#f87171] transition-colors ml-3 opacity-0 group-hover:opacity-100 shrink-0"
                title="移除"
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
              </button>
            </div>
          ))
        )}
      </div>

      {/* ── Add server form ────────────────────────────────── */}
      <div className="bg-[#000000] border border-[#27272a] rounded-lg p-4 space-y-3">
        <p className="text-[12px] font-bold text-[#a1a1aa]">添加服务器</p>
        <div className="flex gap-2">
          <input
            type="text"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="名称 (如 unityMCP)"
            className="w-32 bg-[#09090b] border border-[#27272a] rounded-md p-2 text-[13px] text-white focus:outline-none theme-ring font-mono placeholder:text-[#3f3f46]"
          />
          <input
            type="text"
            value={newUrl}
            onChange={(e) => setNewUrl(e.target.value)}
            placeholder="http://localhost:8080/mcp"
            className="flex-1 bg-[#09090b] border border-[#27272a] rounded-md p-2 text-[13px] text-white focus:outline-none theme-ring font-mono placeholder:text-[#3f3f46]"
          />
          <button
            onClick={handleAddServer}
            disabled={!newName.trim() || !newUrl.trim()}
            className="px-3 py-2 text-[12px] font-bold theme-bg theme-bg-hover text-white rounded-md transition-colors shrink-0 disabled:opacity-30 disabled:cursor-not-allowed"
          >
            添加
          </button>
        </div>
      </div>

      {/* ── Discovery result ───────────────────────────────── */}
      {discoverMsg && (
        <p className={`text-[12px] ${discoverMsg.type === 'error' ? 'text-[#f48771]' : 'text-[#86d9a3]'}`}>
          {discoverMsg.text}
        </p>
      )}

      {/* ── Discovered tools ───────────────────────────────── */}
      {mcpDiscoveredTools.length > 0 && (
        <div className="space-y-2">
          <p className="text-[12px] font-bold text-[#a1a1aa] uppercase tracking-wider">已发现的工具 ({mcpDiscoveredTools.length})</p>
          <div className="bg-[#000000] border border-[#27272a] rounded-lg divide-y divide-[#18181b] max-h-[200px] overflow-y-auto">
            {mcpDiscoveredTools.map((tool) => (
              <div key={tool.name} className="px-4 py-2.5">
                <div className="flex items-center gap-2">
                  <span className="text-[12px] font-bold text-[#e4e4e7] font-mono">{tool.name}</span>
                </div>
                {tool.description && (
                  <p className="text-[11px] text-[#71717a] mt-0.5 line-clamp-2">{tool.description}</p>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── Tip ────────────────────────────────────────────── */}
      <div className="p-3 bg-[#000000] border border-[#27272a] rounded-md">
        <p className="text-[11px] text-[#71717a] leading-relaxed">
          💡 <span className="text-[#a1a1aa]">提示</span>：MCP 服务器需先启动并监听指定端口，然后点击「扫描工具」发现可用工具。发现后的工具会在对话中自动供 AI 调用。Unity MCP 服务器默认地址为 <span className="font-mono text-[#a1a1aa]">http://localhost:8080/mcp</span>。
        </p>
      </div>
    </div>
  );
}

// ── Data Management Panel ────────────────────────────────────────────

function DataManagerPanel({ t }: { t: any }) {
  const clearChatHistory = useAppStore((s) => s.clearChatHistory);
  const resetAllSettings = useAppStore((s) => s.resetAllSettings);
  const [confirmClear, setConfirmClear] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);

  return (
    <div className="space-y-6">
      <h3 className="text-[13px] font-bold text-[#a1a1aa] uppercase tracking-wider">{t.dataManagement}</h3>

      <p className="text-[11.5px] text-[#71717a] leading-relaxed">
        管理本地数据。设置与会话索引保存在 localStorage，完整会话记录保存在 MAIN 应用数据目录，不写入项目的 .MAIN 目录。
      </p>

      {/* Clear Chat History */}
      <div className="bg-[#000000] border border-[#27272a] rounded-lg p-4 space-y-3">
        <div className="flex items-center gap-2">
          <svg className="w-4 h-4 text-[#f59e0b]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="3 6 5 6 21 6" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
          </svg>
          <span className="text-[13px] font-bold text-[#e4e4e7]">{t.clearHistory}</span>
        </div>
        <p className="text-[11.5px] text-[#71717a] leading-relaxed">{t.clearHistoryDesc}</p>
        {!confirmClear ? (
          <button
            onClick={() => setConfirmClear(true)}
            className="px-4 py-2 text-[12px] font-bold bg-[#18181b] text-[#f59e0b] border border-[#292524] rounded-md hover:bg-[#2e1f0f] transition-colors"
          >
            {t.clearHistory}
          </button>
        ) : (
          <div className="flex items-center gap-3">
            <p className="text-[12px] text-[#f87171] font-bold">{t.clearHistoryConfirm}</p>
            <button
              onClick={async () => {
                await clearProjectSessions(useAppStore.getState().currentWorkspace).catch(() => {});
                clearChatHistory();
                setConfirmClear(false);
              }}
              className="px-4 py-2 text-[12px] font-bold bg-[#7f1d1d] text-white border border-[#991b1b] rounded-md hover:bg-[#991b1b] transition-colors"
            >
              确认清空
            </button>
            <button
              onClick={() => setConfirmClear(false)}
              className="px-4 py-2 text-[12px] font-bold bg-[#18181b] text-[#a1a1aa] border border-[#27272a] rounded-md hover:text-white transition-colors"
            >
              取消
            </button>
          </div>
        )}
      </div>

      {/* Reset All Settings */}
      <div className="bg-[#000000] border border-[#27272a] rounded-lg p-4 space-y-3">
        <div className="flex items-center gap-2">
          <svg className="w-4 h-4 text-[#f87171]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" /><line x1="12" y1="9" x2="12" y2="13" /><line x1="12" y1="17" x2="12.01" y2="17" />
          </svg>
          <span className="text-[13px] font-bold text-[#e4e4e7]">{t.resetSettings}</span>
        </div>
        <p className="text-[11.5px] text-[#71717a] leading-relaxed">{t.resetSettingsDesc}</p>
        {!confirmReset ? (
          <button
            onClick={() => setConfirmReset(true)}
            className="px-4 py-2 text-[12px] font-bold bg-[#18181b] text-[#f87171] border border-[#7f1d1d] rounded-md hover:bg-[#7f1d1d] transition-colors"
          >
            {t.resetSettings}
          </button>
        ) : (
          <div className="flex items-center gap-3">
            <p className="text-[12px] text-[#f87171] font-bold">{t.resetSettingsConfirm}</p>
            <button
              onClick={() => {
                resetAllSettings();
                setConfirmReset(false);
              }}
              className="px-4 py-2 text-[12px] font-bold bg-[#7f1d1d] text-white border border-[#991b1b] rounded-md hover:bg-[#991b1b] transition-colors"
            >
              确认重置
            </button>
            <button
              onClick={() => setConfirmReset(false)}
              className="px-4 py-2 text-[12px] font-bold bg-[#18181b] text-[#a1a1aa] border border-[#27272a] rounded-md hover:text-white transition-colors"
            >
              取消
            </button>
          </div>
        )}
      </div>

      {/* Tip */}
      <div className="p-3 bg-[#000000] border border-[#27272a] rounded-md">
        <p className="text-[11px] text-[#71717a] leading-relaxed">
          💡 <span className="text-[#a1a1aa]">提示</span>：所有数据保存在浏览器本地存储中。重置设置不会删除已解压到 .protocols/ 目录的协议包文件，如需彻底清理请手动删除该目录。
        </p>
      </div>
    </div>
  );
}

function DebugLogPanel({ t }: { t: any }) {
  const [snapshot, setSnapshot] = useState({ path: "", content: "", truncated: false });
  const [status, setStatus] = useState("");

  const refresh = useCallback(async () => {
    const next = await readDebugLogSnapshot(1024 * 1024);
    setSnapshot(next);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const logText = snapshot.content || "";

  const handleCopy = async () => {
    await copyDebugLogToClipboard(logText || "暂无调试日志");
    setStatus("已复制调试日志");
    window.setTimeout(() => setStatus(""), 1800);
  };

  const handleExport = async () => {
    const filePath = await save({
      defaultPath: `main-debug-${new Date().toISOString().replace(/[:.]/g, "-")}.log`,
      filters: [{ name: "Log", extensions: ["log", "txt"] }],
    });
    if (!filePath) return;
    await exportTextFile(filePath, logText || "暂无调试日志");
    setStatus("调试日志已导出");
    window.setTimeout(() => setStatus(""), 1800);
  };

  const handleClear = async () => {
    await clearDebugLog();
    await refresh();
    setStatus("调试日志已清空");
    window.setTimeout(() => setStatus(""), 1800);
  };

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h3 className="text-[13px] font-bold text-[#a1a1aa] uppercase tracking-wider">{t.debugLog}</h3>
          <p className="mt-1 text-[11.5px] text-[#71717a] leading-relaxed">
            记录前端 console、界面崩溃、Rust 代理请求和流式读取错误。日志会自动隐藏常见密钥字段。
          </p>
        </div>
        <button
          onClick={refresh}
          className="shrink-0 rounded-md border border-[#27272a] bg-[#18181b] px-3 py-1.5 text-[12px] font-bold text-[#a1a1aa] transition-colors hover:text-white"
        >
          刷新
        </button>
      </div>

      <div className="rounded-lg border border-[#27272a] bg-[#000000] p-3">
        <div className="mb-2 text-[11px] font-bold text-[#a1a1aa]">日志文件</div>
        <div className="break-all font-mono text-[11px] text-[#71717a]">{snapshot.path || "localStorage:main.debugLog.v1"}</div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <button onClick={handleCopy} className="rounded-md border border-[#27272a] bg-[#18181b] px-3 py-2 text-[12px] font-bold text-[#e4e4e7] transition-colors hover:border-[#3f3f46]">
          复制日志
        </button>
        <button onClick={handleExport} className="rounded-md border border-[#27272a] bg-[#18181b] px-3 py-2 text-[12px] font-bold text-[#e4e4e7] transition-colors hover:border-[#3f3f46]">
          导出日志
        </button>
        <button onClick={handleClear} className="rounded-md border border-[#3f1f1f] bg-[#181111] px-3 py-2 text-[12px] font-bold text-[#fca5a5] transition-colors hover:border-[#7f1d1d]">
          清空日志
        </button>
        {status && <span className="text-[12px] text-[#86d9a3]">{status}</span>}
        {snapshot.truncated && <span className="text-[12px] text-[#fbbf24]">当前只显示日志尾部</span>}
      </div>

      <textarea
        readOnly
        value={logText || "暂无调试日志"}
        className="h-[320px] w-full resize-none rounded-lg border border-[#27272a] bg-[#000000] p-3 font-mono text-[11px] leading-5 text-[#a1a1aa] outline-none"
      />
    </div>
  );
}

function FeishuGuideModal({ t, language, onClose }: { t: any; language: "zh" | "en"; onClose: () => void }) {
  const isEn = language === "en";
  const feishuSteps = isEn
    ? [
        "Open Feishu Developer Console and create an enterprise self-built app.",
        "Enable bot capability, then add the bot to your Feishu account.",
        "Enable event subscription by long connection and subscribe to im.message.receive_v1.",
        "Grant message receive and bot message send permissions, then publish or install the app in the tenant.",
        "Copy the App ID and App Secret from the app credentials page.",
      ]
    : [
        "打开飞书开放平台控制台，创建一个企业自建应用。",
        "启用机器人能力，并把机器人添加到你的飞书账号。",
        "开启事件订阅的长连接模式，订阅 im.message.receive_v1 事件。",
        "授予接收消息、机器人发送消息相关权限，然后在企业内发布或安装应用。",
        "在应用凭证页面复制 App ID 和 App Secret。",
      ];
  const mainSteps = isEn
    ? [
        "Open MAIN Settings > IM Adapters.",
        "Confirm Node.js Runtime is found, or click Quick Configure Node.js and follow the integrated terminal output.",
        "Fill App ID, App Secret and keep the Feishu domain as https://open.feishu.cn unless your tenant uses Lark.",
        "Click Test Connection to verify credentials.",
        "Enable the Feishu adapter and keep MAIN running with a workspace open.",
        "In Feishu private chat, send /pair plus the pairing code shown in MAIN, or approve the pairing request in this panel.",
      ]
    : [
        "打开 MAIN 的「系统设置 > 即时通讯适配器」。",
        "确认 Node.js 运行环境已找到；如果没有，点击「快速配置 Node.js」并按集成终端提示操作。",
        "填写 App ID、App Secret；国内飞书通常保持域名 https://open.feishu.cn。",
        "点击「测试连接」确认凭据有效。",
        "启用飞书适配器，并保持 MAIN 打开且已经选择工作区。",
        "在飞书私聊机器人发送 /pair 加 MAIN 面板里的配对码，或在本面板中通过配对请求。",
      ];
  const commands = isEn
    ? [
        "Plain text: run read-only analysis in the current MAIN workspace by default.",
        "Use /execute or /plan before a task when you want MAIN to modify files or create a reviewed plan.",
        "/status: show adapter, MAIN and workspace status.",
        "/stop: stop current generation and clear queued remote messages.",
        "/approve CODE or /reject CODE: allow or reject a tool action requested by a remote task.",
        "If replies fail with 400, check the bot message-send permission and whether the bot can send private messages to you.",
      ]
    : [
        "普通文本：默认在 MAIN 当前工作区执行只读分析。",
        "需要修改文件或先出方案时，在任务前加 /execute 或 /plan。",
        "/status：查看飞书适配器、MAIN 和工作区状态。",
        "/stop：停止当前生成，并清空远程队列。",
        "/approve CODE 或 /reject CODE：远程允许或拒绝工具执行。",
        "如果回消息出现 400，请检查机器人发送消息权限，以及机器人是否允许给你发送私聊。",
      ];

  const renderList = (items: string[]) => (
    <ol className="space-y-2 text-[13px] leading-relaxed text-[#d4d4d8]">
      {items.map((item, index) => (
        <li key={item} className="flex gap-3">
          <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-[#3f3f46] bg-[#18181b] text-[11px] font-bold text-[#a1a1aa]">{index + 1}</span>
          <span>{item}</span>
        </li>
      ))}
    </ol>
  );

  return (
    <div className="absolute inset-0 z-[70] flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm">
      <div className="flex max-h-[86vh] w-[min(920px,94vw)] flex-col overflow-hidden rounded-xl border border-[#27272a] bg-[#09090b] shadow-2xl">
        <div className="flex items-center justify-between border-b border-[#27272a] bg-[#000000] px-5 py-4">
          <h3 className="text-[16px] font-bold text-white">{t.feishuGuideTitle}</h3>
          <button onClick={onClose} className="text-[#a1a1aa] transition-colors hover:text-white"><IconClose className="h-4 w-4" /></button>
        </div>
        <div className="grid gap-5 overflow-y-auto p-5 md:grid-cols-2">
          <section className="rounded-lg border border-[#27272a] bg-[#000000] p-4">
            <h4 className="mb-3 text-[13px] font-bold uppercase tracking-wider text-[#a1a1aa]">{t.feishuGuideFeishuSteps}</h4>
            {renderList(feishuSteps)}
          </section>
          <section className="rounded-lg border border-[#27272a] bg-[#000000] p-4">
            <h4 className="mb-3 text-[13px] font-bold uppercase tracking-wider text-[#a1a1aa]">{t.feishuGuideMainSteps}</h4>
            {renderList(mainSteps)}
          </section>
          <section className="rounded-lg border border-[#27272a] bg-[#000000] p-4 md:col-span-2">
            <h4 className="mb-3 text-[13px] font-bold uppercase tracking-wider text-[#a1a1aa]">{t.feishuGuideCommands}</h4>
            <div className="grid gap-2 md:grid-cols-2">
              {commands.map((item) => (
                <div key={item} className="rounded-md border border-[#18181b] bg-[#09090b] px-3 py-2 text-[13px] leading-relaxed text-[#d4d4d8]">{item}</div>
              ))}
            </div>
          </section>
        </div>
        <div className="flex justify-end border-t border-[#27272a] bg-[#000000] px-5 py-4">
          <button onClick={onClose} className="rounded-md border border-[#27272a] bg-[#18181b] px-4 py-2 text-[12px] font-bold text-[#e4e4e7] transition-colors hover:border-[#3f3f46]">
            {t.feishuGuideClose}
          </button>
        </div>
      </div>
    </div>
  );
}

function buildNodeSetupCommand(language: "zh" | "en"): string {
  const platform = typeof navigator !== "undefined" ? navigator.platform.toLowerCase() : "";
  if (platform.includes("win")) {
    return [
      "echo [MAIN] Checking Node.js runtime...",
      "where node && node -v || winget install -e --id OpenJS.NodeJS.LTS",
      "echo [MAIN] If Node.js was installed just now, restart MAIN before starting the Feishu adapter.",
    ].join("\n");
  }

  if (platform.includes("linux")) {
    return [
      "echo \"[MAIN] Checking Node.js runtime...\"",
      "if command -v node >/dev/null 2>&1; then",
      "  echo \"[MAIN] Node.js found: $(node -v) ($(command -v node))\"",
      "elif command -v apt-get >/dev/null 2>&1; then",
      "  echo \"[MAIN] Installing Node.js with apt. You may be asked for your password.\"",
      "  sudo apt-get update && sudo apt-get install -y nodejs npm",
      "elif command -v dnf >/dev/null 2>&1; then",
      "  sudo dnf install -y nodejs npm",
      "elif command -v pacman >/dev/null 2>&1; then",
      "  sudo pacman -S --needed nodejs npm",
      "else",
      `  echo "${language === "en" ? "Please install Node.js LTS from https://nodejs.org, then restart MAIN." : "请从 https://nodejs.org 安装 Node.js LTS，然后重启 MAIN。"}"`,
      "fi",
      "if command -v node >/dev/null 2>&1; then echo \"[MAIN] Done: $(node -v)\"; fi",
    ].join("\n");
  }

  return [
    "echo \"[MAIN] Checking Node.js runtime...\"",
    "if [ -x /opt/homebrew/bin/brew ]; then eval \"$(/opt/homebrew/bin/brew shellenv)\"; fi",
    "if [ -x /usr/local/bin/brew ]; then eval \"$(/usr/local/bin/brew shellenv)\"; fi",
    "if command -v node >/dev/null 2>&1; then",
    "  echo \"[MAIN] Node.js found: $(node -v) ($(command -v node))\"",
    "elif command -v brew >/dev/null 2>&1; then",
    "  echo \"[MAIN] Installing Node.js LTS with Homebrew...\"",
    "  brew install node",
    "else",
    `  echo "${language === "en" ? "Homebrew was not found. Install Homebrew first, then click this button again:" : "未找到 Homebrew。请先安装 Homebrew，然后再次点击这个按钮："}"`,
    "  echo '/bin/bash -c \"$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)\"'",
    "fi",
    "if [ -x /opt/homebrew/bin/brew ]; then eval \"$(/opt/homebrew/bin/brew shellenv)\"; fi",
    "if [ -x /usr/local/bin/brew ]; then eval \"$(/usr/local/bin/brew shellenv)\"; fi",
    "if command -v node >/dev/null 2>&1; then",
    "  echo \"[MAIN] Done: $(node -v)\"",
    "else",
    `  echo "${language === "en" ? "Node.js is still unavailable. Install Node.js LTS from https://nodejs.org, then restart MAIN." : "Node.js 仍不可用。请从 https://nodejs.org 安装 Node.js LTS，然后重启 MAIN。"}"`,
    "fi",
  ].join("\n");
}

function FeishuAdapterPanel({ config, setConfig, t }: { config: any; setConfig: (patch: any) => void; t: any }) {
  const [testMsg, setTestMsg] = useState<{ text: string; type: "success" | "error" } | null>(null);
  const [isTesting, setIsTesting] = useState(false);
  const [nodeRuntime, setNodeRuntime] = useState<any | null>(null);
  const [nodeSetupMsg, setNodeSetupMsg] = useState<{ text: string; type: "success" | "error" } | null>(null);
  const [showGuide, setShowGuide] = useState(false);
  const status = useAppStore((s) => s.feishuAdapterStatus);
  const pairingRequests = useAppStore((s) => s.feishuPairingRequests);
  const removePairingRequest = useAppStore((s) => s.removeFeishuPairingRequest);
  const imAdapters = normalizeImAdaptersConfig(config.imAdapters);
  const feishu = imAdapters.feishu;
  const language = config.language === "en" ? "en" : "zh";

  useEffect(() => {
    if (!testMsg) return;
    const timer = setTimeout(() => setTestMsg(null), 5000);
    return () => clearTimeout(timer);
  }, [testMsg]);

  const refreshNodeRuntime = useCallback(async () => {
    try {
      const status = await invoke<any>("get_feishu_node_runtime_status");
      setNodeRuntime(status);
    } catch (error) {
      setNodeRuntime({
        found: false,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }, []);

  useEffect(() => {
    void refreshNodeRuntime();
  }, [refreshNodeRuntime]);

  useEffect(() => {
    if (!nodeSetupMsg) return;
    const timer = setTimeout(() => setNodeSetupMsg(null), 7000);
    return () => clearTimeout(timer);
  }, [nodeSetupMsg]);

  const updateFeishu = (patch: any) => {
    setConfig((prev: any) => {
      const nextAdapters = normalizeImAdaptersConfig(prev.imAdapters);
      return {
        ...prev,
        imAdapters: {
          ...nextAdapters,
          feishu: {
            ...nextAdapters.feishu,
            ...patch,
          },
        },
      };
    });
  };

  const handleTest = async () => {
    setIsTesting(true);
    setTestMsg(null);
    try {
      const result = await invoke<string>("test_feishu_adapter_connection", {
        appId: feishu.appId,
        appSecret: feishu.appSecret,
        domain: feishu.domain,
      });
      setTestMsg({ text: result, type: "success" });
    } catch (error) {
      setTestMsg({ text: error instanceof Error ? error.message : String(error), type: "error" });
    } finally {
      setIsTesting(false);
    }
  };

  const handleSetupNodeRuntime = async () => {
    setNodeSetupMsg(null);
    try {
      useAppStore.getState().setShowTerminal(true);
      await spawnPty(140, 40);
      await writePty(buildNodeSetupCommand(language) + "\n");
      setNodeSetupMsg({
        type: "success",
        text: language === "en"
          ? "The setup command is running in the integrated terminal."
          : "已在集成终端中执行配置命令。",
      });
      setTimeout(() => {
        void refreshNodeRuntime();
      }, 1500);
    } catch (error) {
      setNodeSetupMsg({
        type: "error",
        text: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const handleApprovePairing = (request: any) => {
    updateFeishu({
      pairedUsers: upsertFeishuPairedUser(feishu.pairedUsers, {
        openId: request.openId,
        name: request.name || request.openId,
        chatId: request.chatId,
        pairedAt: Date.now(),
        lastSeenAt: Date.now(),
      }),
    });
    removePairingRequest(request.openId);
    invoke("send_feishu_message", {
      chatId: request.chatId,
      userId: request.openId,
      openId: request.openId,
      messageId: request.messageId,
      text: language === "en"
        ? "Pairing approved in MAIN. You can now send remote tasks."
        : "已在 MAIN 中通过配对。现在可以发送远程任务了。",
    }).catch(() => {});
  };

  const handleRejectPairing = (request: any) => {
    removePairingRequest(request.openId);
    invoke("send_feishu_message", {
      chatId: request.chatId,
      userId: request.openId,
      openId: request.openId,
      messageId: request.messageId,
      text: language === "en" ? "Pairing rejected in MAIN." : "已在 MAIN 中拒绝配对。",
    }).catch(() => {});
  };

  const handleRemoveUser = (openId: string) => {
    updateFeishu({
      pairedUsers: feishu.pairedUsers.filter((user: any) => user.openId !== openId),
    });
  };

  const statusColor = status.status === "connected"
    ? "bg-[#14532d] text-[#86d9a3] border-[#166534]"
    : status.status === "error"
    ? "bg-[#3f1111] text-[#fca5a5] border-[#7f1d1d]"
    : "bg-[#18181b] text-[#a1a1aa] border-[#27272a]";

  return (
    <div className="space-y-6">
      {showGuide && <FeishuGuideModal t={t} language={language} onClose={() => setShowGuide(false)} />}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-[13px] font-bold uppercase tracking-wider text-[#a1a1aa]">{t.feishuAdapter}</h3>
          <p className="mt-1 text-[11.5px] leading-relaxed text-[#71717a]">{t.feishuAdapterDesc}</p>
        </div>
        <button onClick={() => setShowGuide(true)} className="rounded-md border border-[#27272a] bg-[#18181b] px-3 py-2 text-[12px] font-bold text-[#e4e4e7] transition-colors hover:border-[#3f3f46]">
          {t.feishuOpenGuide}
        </button>
      </div>

      <div className="rounded-lg border border-[#27272a] bg-[#000000] p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <label className="flex items-center gap-3">
            <input
              type="checkbox"
              checked={feishu.enabled}
              onChange={(e) => updateFeishu({ enabled: e.target.checked })}
            />
            <span className="text-[13px] font-bold text-[#e4e4e7]">{t.feishuEnable}</span>
          </label>
          <span className={`rounded-full border px-3 py-1 text-[11px] font-bold uppercase tracking-wider ${statusColor}`}>
            {t.feishuStatus}: {status.status}
          </span>
        </div>
        {status.message && <p className="mt-3 text-[11.5px] leading-relaxed text-[#71717a]">{status.message}</p>}
      </div>

      <div className="rounded-lg border border-[#27272a] bg-[#000000] p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="text-[12px] font-bold uppercase tracking-wider text-[#a1a1aa]">{t.feishuNodeRuntime}</div>
            <p className={`mt-1 text-[11.5px] leading-relaxed ${nodeRuntime?.found ? "text-[#86d9a3]" : "text-[#fca5a5]"}`}>
              {nodeRuntime?.message || t.feishuNodeRuntimeChecking}
              {nodeRuntime?.executable ? ` (${nodeRuntime.executable})` : ""}
            </p>
            <p className="mt-1 text-[11px] leading-relaxed text-[#71717a]">{t.feishuNodeRuntimeDesc}</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <button onClick={refreshNodeRuntime} className="rounded-md border border-[#27272a] bg-[#18181b] px-3 py-2 text-[12px] font-bold text-[#e4e4e7] transition-colors hover:border-[#3f3f46]">
              {t.feishuRefreshNodeRuntime}
            </button>
            <button onClick={handleSetupNodeRuntime} className="rounded-md border border-[#14532d] bg-[#052e16] px-3 py-2 text-[12px] font-bold text-[#86d9a3] transition-colors hover:border-[#166534]">
              {t.feishuSetupNodeRuntime}
            </button>
          </div>
        </div>
        {nodeSetupMsg && <p className={`mt-3 text-[12px] ${nodeSetupMsg.type === "error" ? "text-[#fca5a5]" : "text-[#86d9a3]"}`}>{nodeSetupMsg.text}</p>}
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <div>
          <label className="mb-2 block text-[13px] font-bold text-[#e4e4e7]">{t.feishuAppId}</label>
          <input value={feishu.appId} onChange={(e) => updateFeishu({ appId: e.target.value })} className="w-full rounded-md border border-[#27272a] bg-[#000000] p-2.5 font-mono text-[14px] text-white outline-none theme-ring" />
        </div>
        <div>
          <label className="mb-2 block text-[13px] font-bold text-[#e4e4e7]">{t.feishuAppSecret}</label>
          <input type="password" value={feishu.appSecret} onChange={(e) => updateFeishu({ appSecret: e.target.value })} className="w-full rounded-md border border-[#27272a] bg-[#000000] p-2.5 font-mono text-[14px] text-white outline-none theme-ring" />
        </div>
        <div className="md:col-span-2">
          <label className="mb-2 block text-[13px] font-bold text-[#e4e4e7]">{t.feishuDomain}</label>
          <input value={feishu.domain} onChange={(e) => updateFeishu({ domain: e.target.value })} className="w-full rounded-md border border-[#27272a] bg-[#000000] p-2.5 font-mono text-[14px] text-white outline-none theme-ring" />
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <button onClick={handleTest} disabled={isTesting || !feishu.appId.trim() || !feishu.appSecret.trim()} className="rounded-md border border-[#27272a] bg-[#18181b] px-3 py-2 text-[12px] font-bold text-[#e4e4e7] transition-colors hover:border-[#3f3f46] disabled:opacity-40">
          {isTesting ? t.feishuTestingConnection : t.feishuTestConnection}
        </button>
        <button onClick={() => updateFeishu({ enabled: true })} disabled={feishu.enabled} className="rounded-md border border-[#27272a] bg-[#18181b] px-3 py-2 text-[12px] font-bold text-[#e4e4e7] transition-colors hover:border-[#3f3f46] disabled:opacity-40">
          {t.feishuStart}
        </button>
        <button onClick={() => updateFeishu({ enabled: false })} disabled={!feishu.enabled} className="rounded-md border border-[#3f1f1f] bg-[#181111] px-3 py-2 text-[12px] font-bold text-[#fca5a5] transition-colors hover:border-[#7f1d1d] disabled:opacity-40">
          {t.feishuStop}
        </button>
        {testMsg && <span className={`text-[12px] ${testMsg.type === "error" ? "text-[#fca5a5]" : "text-[#86d9a3]"}`}>{testMsg.text}</span>}
      </div>

      <div className="rounded-lg border border-[#27272a] bg-[#000000] p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="text-[12px] font-bold uppercase tracking-wider text-[#a1a1aa]">{t.feishuPairingCode}</div>
            <div className="mt-1 font-mono text-[28px] font-bold text-[#e4e4e7]">{feishu.pairingCode}</div>
            <p className="mt-1 text-[11.5px] text-[#71717a]">{t.feishuPairingCodeDesc}</p>
          </div>
          <button onClick={() => updateFeishu({ pairingCode: createFeishuPairingCode() })} className="rounded-md border border-[#27272a] bg-[#18181b] px-3 py-2 text-[12px] font-bold text-[#e4e4e7] transition-colors hover:border-[#3f3f46]">
            {t.feishuRegenerateCode}
          </button>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="rounded-lg border border-[#27272a] bg-[#000000] p-4">
          <h4 className="mb-3 text-[12px] font-bold uppercase tracking-wider text-[#a1a1aa]">{t.feishuPendingPairings}</h4>
          {pairingRequests.length === 0 ? (
            <p className="text-[12px] text-[#71717a]">{t.feishuNoPendingPairings}</p>
          ) : (
            <div className="space-y-2">
              {pairingRequests.map((request: any) => (
                <div key={request.openId} className="rounded-md border border-[#18181b] bg-[#09090b] p-3">
                  <div className="font-mono text-[12px] text-[#e4e4e7]">{request.name}</div>
                  <div className="mt-1 truncate font-mono text-[10px] text-[#71717a]">{request.openId}</div>
                  <div className="mt-3 flex gap-2">
                    <button onClick={() => handleApprovePairing(request)} className="rounded-md border border-[#14532d] bg-[#052e16] px-2.5 py-1.5 text-[11px] font-bold text-[#86d9a3]">{t.feishuApprovePairing}</button>
                    <button onClick={() => handleRejectPairing(request)} className="rounded-md border border-[#3f1f1f] bg-[#181111] px-2.5 py-1.5 text-[11px] font-bold text-[#fca5a5]">{t.feishuRejectPairing}</button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="rounded-lg border border-[#27272a] bg-[#000000] p-4">
          <h4 className="mb-3 text-[12px] font-bold uppercase tracking-wider text-[#a1a1aa]">{t.feishuPairedUsers}</h4>
          {feishu.pairedUsers.length === 0 ? (
            <p className="text-[12px] text-[#71717a]">{t.feishuNoPairedUsers}</p>
          ) : (
            <div className="space-y-2">
              {feishu.pairedUsers.map((user: any) => (
                <div key={user.openId} className="flex items-center justify-between gap-3 rounded-md border border-[#18181b] bg-[#09090b] p-3">
                  <div className="min-w-0">
                    <div className="truncate font-mono text-[12px] text-[#e4e4e7]">{user.name}</div>
                    <div className="mt-1 truncate font-mono text-[10px] text-[#71717a]">{user.openId}</div>
                  </div>
                  <button onClick={() => handleRemoveUser(user.openId)} className="shrink-0 rounded-md border border-[#3f1f1f] bg-[#181111] px-2.5 py-1.5 text-[11px] font-bold text-[#fca5a5]">{t.feishuRemovePairing}</button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="rounded-md border border-[#27272a] bg-[#000000] p-3">
        <p className="text-[11px] leading-relaxed text-[#71717a]">{t.feishuRoutingCurrentWorkspace}</p>
      </div>
    </div>
  );
}

export default function SettingsModal({
  isOpen,
  onClose,
  config,
  setConfig,
  t,
  THEMES,
  settingsTab,
  setSettingsTab,
  mcpServers,
  setMcpServers,
  mcpDiscoveredTools,
  setMcpDiscoveredTools,
}: {
  isOpen: boolean;
  onClose: () => void;
  config: any;
  setConfig: (patch: any) => void;
  t: any;
  THEMES: any;
  settingsTab: string;
  setSettingsTab: (tab: string) => void;
  mcpServers: MCPServer[];
  setMcpServers: (servers: MCPServer[]) => void;
  mcpDiscoveredTools: MCPTool[];
  setMcpDiscoveredTools: (tools: MCPTool[], toolServerMap: Record<string, string>) => void;
}) {
  const [availableModels, setAvailableModels] = useState([]);
  const [cloudModelsByServer, setCloudModelsByServer] = useState<Record<string, string[]>>({});
  const [cloudServerSearch, setCloudServerSearch] = useState("");
  const [cloudDraftServer, setCloudDraftServer] = useState<any | null>(null);
  const [cloudDraftMode, setCloudDraftMode] = useState<"saved" | "new" | null>(null);
  const [isFetchingModels, setIsFetchingModels] = useState(false);
  const [isFetchingCloudModels, setIsFetchingCloudModels] = useState(false);
  const [isTestingCloudConnection, setIsTestingCloudConnection] = useState(false);
  const [cloudModelInputMode, setCloudModelInputMode] = useState<"select" | "manual">("manual");
  const [cloudFetchMsg, setCloudFetchMsg] = useState<{ text: string; type: 'success' | 'error' } | null>(null);
  const [cloudProbeMsg, setCloudProbeMsg] = useState<{ text: string; type: 'success' | 'warning' | 'error' } | null>(null);
  const [cloudConnectionStatus, setCloudConnectionStatus] = useState<{
    fingerprint: string;
    model: string;
    text: string;
  } | null>(null);
  const [cloudSaveMsg, setCloudSaveMsg] = useState<{ text: string; type: 'success' | 'error' } | null>(null);
  const [localFetchMsg, setLocalFetchMsg] = useState<{ text: string; type: 'success' | 'error' } | null>(null);
  const [systemMemory, setSystemMemory] = useState<{ total_gb: number; available_gb: number; total_bytes?: number; available_bytes?: number } | null>(null);
  const hasAutoFetched = useRef(false);
  const cloudDraftServerRef = useRef<any | null>(null);

  // Auto-clear cloud fetch message after 5 seconds
  useEffect(() => {
    if (!cloudFetchMsg) return;
    const timer = setTimeout(() => setCloudFetchMsg(null), 5000);
    return () => clearTimeout(timer);
  }, [cloudFetchMsg]);

  useEffect(() => {
    if (!cloudProbeMsg) return;
    const timer = setTimeout(() => setCloudProbeMsg(null), 5000);
    return () => clearTimeout(timer);
  }, [cloudProbeMsg]);

  useEffect(() => {
    if (!cloudSaveMsg) return;
    const timer = setTimeout(() => setCloudSaveMsg(null), 2500);
    return () => clearTimeout(timer);
  }, [cloudSaveMsg]);

  // Auto-clear local fetch message after 5 seconds
  useEffect(() => {
    if (!localFetchMsg) return;
    const timer = setTimeout(() => setLocalFetchMsg(null), 5000);
    return () => clearTimeout(timer);
  }, [localFetchMsg]);

  // Fetch system memory whenever settings opens, so the slider reflects memory left after the model loads.
  useEffect(() => {
    if (!isOpen) return;
    invoke<{ total_gb: number; available_gb: number; total_bytes?: number; available_bytes?: number }>("get_system_memory")
      .then(setSystemMemory)
      .catch(() => { });
  }, [isOpen]);

  const handleProviderChange = (e) => {
    const provider = e.target.value;
    let endpoint = config.local.endpoint;
    if (provider === "LM Studio") endpoint = "http://127.0.0.1:1234/v1";
    if (provider === "Ollama") endpoint = "http://127.0.0.1:11434/v1";
    if (provider === "OMLX") endpoint = "http://127.0.0.1:8000/v1";
    setConfig({ ...config, local: { ...config.local, provider, endpoint, model: "" } });
  };

  const getVramEstimate = (tokens) => {
    const mb = (tokens / 1000) * 130;
    if (mb >= 1024) return { text: `~${(mb / 1024).toFixed(1)} GB`, value: mb };
    return { text: `~${Math.round(mb)} MB`, value: mb };
  };

  const getTokensForKvCacheGb = (gb: number) => Math.max(4096, Math.floor((gb * 1024 / 130) * 1000 / 4096) * 4096);

  // Get pressure color based on slider position (0 = blue/safe, 1 = red/danger)
  const getPressureColor = (ratio: number) => {
    if (ratio < 0.4) return { main: '#60a5fa', glow: 'rgba(96,165,250,0.3)' };
    if (ratio < 0.7) return { main: '#a78bfa', glow: 'rgba(167,139,250,0.3)' };
    return { main: '#f97316', glow: 'rgba(249,115,22,0.3)' };
  };

  const fetchModels = useCallback(async (endpointOverride?: string, providerOverride?: string) => {
    setIsFetchingModels(true);
    setAvailableModels([]);
    setLocalFetchMsg(null);

    const provider = providerOverride || config.local.provider;
    const endpoint = endpointOverride || config.local.endpoint;
    const { apiKey } = config.local;
    const headers = apiKey ? { "Authorization": `Bearer ${apiKey}` } : null;

    const candidates: string[] = [];
    const ep = endpoint.replace(/\/+$/, "");

    if (provider === "Ollama") {
      const base = ep.replace(/\/v1\/?$/i, "");
      candidates.push(`${base}/api/tags`, `${base}/api/ps`);
    } else {
      if (ep.endsWith("/v1")) {
        candidates.push(`${ep}/models`, `${ep.replace(/\/v1\/?$/i, "")}/models`);
      } else {
        candidates.push(`${ep}/v1/models`, `${ep}/models`);
      }
    }

    for (const fetchUrl of candidates) {
      try {
        const body = await invoke<string>("proxy_request", {
          url: fetchUrl,
          method: "GET",
          headers,
          body: null,
        });
        const data = JSON.parse(body);
        let models: string[] = [];

        if (provider === "Ollama") {
          models = data.models?.map(item => item.name || item.model) || [];
        } else {
          models = data.data?.map(item => item.id) || [];
        }

        if (models.length > 0) {
          setAvailableModels(models);
          if (!models.includes(config.local.model)) {
            setConfig(prev => ({ ...prev, local: { ...prev.local, model: models[0] } }));
          }
          setLocalFetchMsg({ text: `已发现 ${models.length} 个模型`, type: 'success' });
          setIsFetchingModels(false);
          return;
        }
      } catch {
        // Try next candidate URL
      }
    }

    setAvailableModels([]);
    setLocalFetchMsg({ text: '无法获取模型列表，请检查服务地址和网络连接', type: 'error' });
    setIsFetchingModels(false);
  }, [config]);

  // Auto-fetch models when local tab opens
  useEffect(() => {
    if (isOpen && settingsTab === 'local' && !hasAutoFetched.current) {
      hasAutoFetched.current = true;
      fetchModels();
    }
    if (!isOpen) hasAutoFetched.current = false;
  }, [isOpen, settingsTab]);

  // Re-fetch when provider or endpoint changes
  const prevProvider = useRef(config.local.provider);
  const prevEndpoint = useRef(config.local.endpoint);
  useEffect(() => {
    if (prevProvider.current !== config.local.provider || prevEndpoint.current !== config.local.endpoint) {
      prevProvider.current = config.local.provider;
      prevEndpoint.current = config.local.endpoint;
      if (hasAutoFetched.current) {
        fetchModels(config.local.endpoint, config.local.provider);
      }
    }
  }, [config.local.provider, config.local.endpoint]);

  const cloudServerState = useMemo(() => normalizeCloudServerState({
    cloud: config.cloud,
    cloudServers: config.cloudServers,
    activeCloudServerId: config.activeCloudServerId,
  }), [config.activeCloudServerId, config.cloud, config.cloudServers]);
  const cloudServers = cloudServerState.cloudServers;
  const activeCloudServerId = cloudServerState.activeCloudServerId;
  const savedActiveCloudServer = cloudServers.find((server) => server.id === activeCloudServerId) || null;
  const draftCloudConfig = cloudDraftServer
    ? { ...createDefaultCloudConfig(), ...cloudDraftServer }
    : createDefaultCloudConfig();
  const cloudAvailableModels = cloudDraftServer ? (cloudModelsByServer[cloudDraftServer.id] || []) : [];
  const cloudProtocol = normalizeCloudProtocol(draftCloudConfig.protocol);
  const cloudApiFormat = normalizeCloudApiFormat(draftCloudConfig.apiFormat);
  const parsedCloudCustomHeaders = parseCloudCustomHeaders(draftCloudConfig.customHeaders || "");
  const filteredCloudServers = cloudServers.filter((server) => {
    const query = cloudServerSearch.trim().toLowerCase();
    if (!query) return true;
    return `${server.name} ${server.endpoint} ${server.provider} ${server.model}`.toLowerCase().includes(query);
  });
  const unsavedDraftMatchesSearch = (() => {
    if (cloudDraftMode !== "new" || !cloudDraftServer) return false;
    const query = cloudServerSearch.trim().toLowerCase();
    if (!query) return true;
    return `${cloudDraftServer.name} ${cloudDraftServer.endpoint} ${cloudDraftServer.provider} ${cloudDraftServer.model}`.toLowerCase().includes(query);
  })();
  const visibleCloudServers = unsavedDraftMatchesSearch
    ? [...filteredCloudServers, cloudDraftServer]
    : filteredCloudServers;
  const cloudEndpointPlaceholder = cloudProtocol === "anthropic"
    ? "https://api.anthropic.com"
    : cloudApiFormat === "responses"
      ? "https://api.openai.com/v1 或完整 /v1/responses 地址"
      : "https://api.openai.com/v1 或完整 /v1/chat/completions 地址";
  const cloudApiKeyPlaceholder = cloudProtocol === "anthropic" ? "sk-ant-..." : "sk-...";
  const cloudModelPlaceholder = cloudProtocol === "anthropic" ? "claude-sonnet-4-5" : "gpt-4.1 / qwen-max / openrouter-model";
  const cloudEndpointHint = cloudProtocol === "anthropic"
    ? "Anthropic 协议通常填写根地址，例如 https://api.anthropic.com"
    : cloudApiFormat === "responses"
      ? "Responses API 可填写 API 根地址（如 https://api.openai.com/v1），也支持直接粘贴完整的 /responses 请求地址"
      : "OpenAI Chat Completions 通常填写 API 根地址（常见以 /v1 结尾），也支持直接粘贴完整的 /chat/completions 地址";
  const cloudConnectionFingerprint = useMemo(() => buildCloudConnectionFingerprint(draftCloudConfig), [
    draftCloudConfig.apiFormat,
    draftCloudConfig.apiKey,
    draftCloudConfig.customHeaders,
    draftCloudConfig.endpoint,
    draftCloudConfig.model,
    draftCloudConfig.protocol,
  ]);
  const activeCloudConnectionStatus = cloudConnectionStatus?.fingerprint === cloudConnectionFingerprint
    ? cloudConnectionStatus
    : null;

  useEffect(() => {
    cloudDraftServerRef.current = cloudDraftServer;
  }, [cloudDraftServer]);

  useEffect(() => {
    if (cloudConnectionStatus && cloudConnectionStatus.fingerprint !== cloudConnectionFingerprint) {
      setCloudConnectionStatus(null);
    }
  }, [cloudConnectionFingerprint, cloudConnectionStatus]);

  useEffect(() => {
    if (!isOpen || settingsTab !== "cloud") return;
    if (cloudDraftMode === "new") return;
    const nextDraft = savedActiveCloudServer ? { ...savedActiveCloudServer } : null;
    setCloudDraftServer(nextDraft);
    setCloudDraftMode(nextDraft ? "saved" : null);
    setCloudModelInputMode(nextDraft && (cloudModelsByServer[nextDraft.id] || []).length > 0 ? "select" : "manual");
    setCloudFetchMsg(null);
    setCloudProbeMsg(null);
  }, [activeCloudServerId, cloudDraftMode, isOpen, savedActiveCloudServer, settingsTab]);

  const makeBlankCloudServerDraft = useCallback(() => ({
    id: `cloud-server-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    name: "",
    ...createDefaultCloudConfig(),
    endpoint: "",
    model: "",
    apiKey: "",
    customHeaders: "",
  }), []);

  const commitCloudServers = useCallback((servers, activeId, prevConfig) => {
    const nextState = normalizeCloudServerState({
      cloud: prevConfig.cloud,
      cloudServers: servers,
      activeCloudServerId: activeId,
    });
    return {
      ...prevConfig,
      cloud: nextState.cloud,
      cloudServers: nextState.cloudServers,
      activeCloudServerId: nextState.activeCloudServerId,
    };
  }, []);

  const clearDraftCloudModelCache = useCallback((serverId = cloudDraftServer?.id) => {
    if (!serverId) return;
    setCloudModelsByServer((prev) => ({ ...prev, [serverId]: [] }));
    setCloudModelInputMode("manual");
  }, [cloudDraftServer?.id]);

  const updateCloudDraftServer = useCallback((patch, options = {}) => {
    setCloudDraftServer((prev) => prev ? { ...prev, ...patch } : prev);
    setCloudSaveMsg(null);
    if (options.clearModels) {
      clearDraftCloudModelCache();
      setCloudFetchMsg(null);
    }
  }, [clearDraftCloudModelCache]);

  const persistCloudServer = useCallback((server) => {
    if (!server) return null;
    const name = String(server.name || "").trim();
    const endpoint = String(server.endpoint || "").trim();
    if (!name || !endpoint) return null;

    const savedServer = createCloudServerConfig({
      ...server,
      name,
      endpoint,
      id: server.id,
    }, name);

    setConfig((prev) => {
      const state = normalizeCloudServerState({
        cloud: prev.cloud,
        cloudServers: prev.cloudServers,
        activeCloudServerId: prev.activeCloudServerId,
      });
      const exists = state.cloudServers.some((item) => item.id === savedServer.id);
      const nextServers = exists
        ? state.cloudServers.map((item) => item.id === savedServer.id ? savedServer : item)
        : [...state.cloudServers, savedServer];
      return commitCloudServers(nextServers, savedServer.id, prev);
    });
    setCloudDraftServer({ ...savedServer });
    setCloudDraftMode("saved");
    return savedServer;
  }, [commitCloudServers, setConfig]);

  const confirmCloudModelSelection = useCallback((model, serverOverride = null) => {
    const sourceServer = serverOverride || cloudDraftServer;
    if (!sourceServer) return;
    const nextModel = String(model || "").trim();
    const nextServer = { ...sourceServer, model: nextModel };

    setCloudDraftServer((prev) => prev && prev.id === sourceServer.id ? { ...prev, model: nextModel } : prev);
    setCloudSaveMsg(null);

    const isSavedServer = cloudServers.some((server) => server.id === sourceServer.id);
    const canPersistServer = isSavedServer || (String(sourceServer.name || "").trim() && String(sourceServer.endpoint || "").trim());
    if (canPersistServer) {
      persistCloudServer(nextServer);
    }
  }, [cloudDraftServer, cloudServers, persistCloudServer]);

  const serializeCloudServerForCompare = useCallback((server) => {
    if (!server) return "";
    return JSON.stringify({
      name: String(server.name ?? ""),
      protocol: normalizeCloudProtocol(server.protocol),
      apiFormat: normalizeCloudApiFormat(server.apiFormat),
      provider: String(server.provider ?? ""),
      endpoint: String(server.endpoint ?? ""),
      model: String(server.model ?? ""),
      apiKey: String(server.apiKey ?? ""),
      customHeaders: String(server.customHeaders ?? ""),
      temperature: Number(server.temperature ?? 0.6),
      topP: Number(server.topP ?? 0.95),
      disableResponseStorage: server.disableResponseStorage !== false,
      reasoningEffort: normalizeOpenAiReasoningEffort(server.reasoningEffort),
    });
  }, []);

  const savedDraftSource = cloudDraftServer
    ? cloudServers.find((server) => server.id === cloudDraftServer.id)
    : null;
  const hasCloudDraftChanges = cloudDraftMode === "new"
    ? Boolean(cloudDraftServer)
    : serializeCloudServerForCompare(cloudDraftServer) !== serializeCloudServerForCompare(savedDraftSource);
  const canSaveCloudServer = Boolean(
    cloudDraftServer &&
    String(cloudDraftServer.name || "").trim() &&
    String(cloudDraftServer.endpoint || "").trim(),
  );

  const selectCloudServer = useCallback((serverId) => {
    const targetServer = cloudServers.find((server) => server.id === serverId);
    if (!targetServer) return;
    setConfig((prev) => {
      const state = normalizeCloudServerState({
        cloud: prev.cloud,
        cloudServers: prev.cloudServers,
        activeCloudServerId: prev.activeCloudServerId,
      });
      return commitCloudServers(state.cloudServers, serverId, prev);
    });
    setCloudDraftServer({ ...targetServer });
    setCloudDraftMode("saved");
    setCloudFetchMsg(null);
    setCloudProbeMsg(null);
    setCloudSaveMsg(null);
    setCloudConnectionStatus(null);
    setCloudModelInputMode((cloudModelsByServer[serverId] || []).length > 0 ? "select" : "manual");
  }, [cloudModelsByServer, cloudServers, commitCloudServers, setConfig]);

  const addCloudServer = useCallback(() => {
    const nextDraft = makeBlankCloudServerDraft();
    setCloudDraftServer(nextDraft);
    setCloudDraftMode("new");
    setCloudFetchMsg(null);
    setCloudProbeMsg(null);
    setCloudSaveMsg(null);
    setCloudConnectionStatus(null);
    setCloudModelInputMode("manual");
  }, [makeBlankCloudServerDraft]);

  const saveCloudServer = useCallback(() => {
    if (!cloudDraftServer) return;
    const name = String(cloudDraftServer.name || "").trim();
    const endpoint = String(cloudDraftServer.endpoint || "").trim();
    if (!name || !endpoint) {
      setCloudSaveMsg({ text: "请先填写 Server Name 和 API Endpoint", type: "error" });
      return;
    }
    persistCloudServer({ ...cloudDraftServer, name, endpoint });
    setCloudFetchMsg(null);
    setCloudProbeMsg(null);
    setCloudConnectionStatus(null);
    setCloudSaveMsg({ text: "已保存服务器配置", type: "success" });
  }, [cloudDraftServer, persistCloudServer]);

  const removeCloudServer = useCallback((serverId) => {
    if (cloudDraftMode === "new" && cloudDraftServer?.id === serverId) {
      setCloudDraftServer(savedActiveCloudServer ? { ...savedActiveCloudServer } : null);
      setCloudDraftMode(savedActiveCloudServer ? "saved" : null);
      setCloudFetchMsg(null);
      setCloudProbeMsg(null);
      setCloudSaveMsg(null);
      setCloudConnectionStatus(null);
      return;
    }
    setConfig((prev) => {
      const state = normalizeCloudServerState({
        cloud: prev.cloud,
        cloudServers: prev.cloudServers,
        activeCloudServerId: prev.activeCloudServerId,
      });
      const removedIndex = state.cloudServers.findIndex((server) => server.id === serverId);
      const nextServers = state.cloudServers.filter((server) => server.id !== serverId);
      const nextActiveId = state.activeCloudServerId === serverId
        ? nextServers[Math.min(Math.max(removedIndex, 0), nextServers.length - 1)]?.id
        : state.activeCloudServerId;
      return commitCloudServers(nextServers, nextActiveId, prev);
    });
    setCloudModelsByServer((prev) => {
      const next = { ...prev };
      delete next[serverId];
      return next;
    });
    if (cloudDraftServer?.id === serverId) {
      const removedIndex = cloudServers.findIndex((server) => server.id === serverId);
      const remainingServers = cloudServers.filter((server) => server.id !== serverId);
      const nextDraftSource = remainingServers[Math.min(Math.max(removedIndex, 0), remainingServers.length - 1)];
      const nextDraft = nextDraftSource ? { ...nextDraftSource } : null;
      setCloudDraftServer(nextDraft);
      setCloudDraftMode(nextDraft ? "saved" : null);
      setCloudModelInputMode(nextDraft && (cloudModelsByServer[nextDraft.id] || []).length > 0 ? "select" : "manual");
    }
    setCloudFetchMsg(null);
    setCloudProbeMsg(null);
    setCloudConnectionStatus(null);
    setCloudSaveMsg(null);
  }, [cloudDraftMode, cloudDraftServer, cloudModelsByServer, cloudServers, commitCloudServers, savedActiveCloudServer, setConfig]);

  const handleCloudProtocolChange = (e) => {
    if (!cloudDraftServer) return;
    const nextProtocol = normalizeCloudProtocol(e.target.value);
    const nextEndpoint = nextProtocol === "anthropic" ? "https://api.anthropic.com" : "https://api.openai.com/v1";
    const previousProtocol = normalizeCloudProtocol(draftCloudConfig.protocol);
    const previousDefaultEndpoint = previousProtocol === "anthropic" ? "https://api.anthropic.com" : "https://api.openai.com/v1";
    const currentEndpoint = draftCloudConfig.endpoint || "";
    const shouldReplaceEndpoint = !currentEndpoint.trim() || currentEndpoint === previousDefaultEndpoint;

    updateCloudDraftServer({
      protocol: nextProtocol,
      apiFormat: nextProtocol === "anthropic" ? "chat_completions" : normalizeCloudApiFormat(draftCloudConfig.apiFormat),
      provider: nextProtocol === "anthropic" ? "Anthropic" : "OpenAI",
      endpoint: shouldReplaceEndpoint ? nextEndpoint : currentEndpoint,
      model: "",
    }, { clearModels: true });
    setCloudFetchMsg(null);
    setCloudProbeMsg(null);
    setCloudConnectionStatus(null);
  };

  const handleCloudApiFormatChange = (e) => {
    const nextApiFormat = normalizeCloudApiFormat(e.target.value);
    updateCloudDraftServer({ apiFormat: nextApiFormat });
    setCloudProbeMsg(null);
    setCloudConnectionStatus(null);
  };

  const refreshCloudModels = useCallback(async (serverOverride = null) => {
    if (isFetchingCloudModels) return;
    const targetServer = serverOverride || cloudDraftServer;
    if (!targetServer) {
      setCloudFetchMsg({ text: "请先新建或选择一个服务器", type: "error" });
      return;
    }
    const targetServerId = targetServer.id;
    const targetProtocol = normalizeCloudProtocol(targetServer.protocol);
    setIsFetchingCloudModels(true);
    setCloudFetchMsg(null);

    try {
      const endpoint = targetServer.endpoint?.trim();
      if (!endpoint) {
        setCloudFetchMsg({ text: "请先填写 API Endpoint", type: "error" });
        return;
      }

      const candidates = buildCloudModelListCandidates(endpoint, targetProtocol);
      const headers = buildCloudHeaders(targetProtocol, targetServer.apiKey || "", false, targetServer.customHeaders);

      for (const url of candidates) {
        try {
          const body = await invoke<string>("proxy_request", {
            url,
            method: "GET",
            headers,
            body: null,
          });
          const models = extractCloudModelIds(JSON.parse(body));
          if (models.length === 0) continue;

          const latestServer = cloudDraftServerRef.current;
          const isStaleResult = !latestServer
            || latestServer.id !== targetServerId
            || normalizeCloudProtocol(latestServer.protocol) !== targetProtocol
            || latestServer.endpoint !== targetServer.endpoint
            || latestServer.apiKey !== targetServer.apiKey
            || latestServer.customHeaders !== targetServer.customHeaders;
          if (isStaleResult) return;

          const selectedModel = models.includes(targetServer.model) ? targetServer.model : models[0];
          setCloudModelsByServer((prev) => ({ ...prev, [targetServerId]: models }));
          setCloudModelInputMode("select");
          confirmCloudModelSelection(selectedModel, targetServer);
          setCloudFetchMsg({ text: `已拉取 ${models.length} 个模型，当前选择 ${selectedModel}`, type: "success" });
          return;
        } catch {
          // Try next candidate URL
        }
      }

      setCloudModelsByServer((prev) => ({ ...prev, [targetServerId]: [] }));
      setCloudFetchMsg({ text: "未发现可用模型，请检查 Endpoint、协议和 API Key", type: "error" });
    } catch (err) {
      setCloudModelsByServer((prev) => ({ ...prev, [targetServerId]: [] }));
      setCloudFetchMsg({ text: "连接失败: " + (err instanceof Error ? err.message : String(err)), type: "error" });
    } finally {
      setIsFetchingCloudModels(false);
    }
  }, [cloudDraftServer, confirmCloudModelSelection, isFetchingCloudModels]);

  const testCloudConnection = useCallback(async () => {
    if (isTestingCloudConnection) return;

    const endpoint = draftCloudConfig.endpoint?.trim();
    const testModel = draftCloudConfig.model?.trim() || cloudAvailableModels[0] || "";
    const targetServer = cloudDraftServer ? {
      ...cloudDraftServer,
      apiFormat: cloudApiFormat,
      endpoint,
      model: testModel,
      protocol: cloudProtocol,
    } : null;
    if (!endpoint) {
      setCloudProbeMsg({ text: "请先填写 API Endpoint", type: "error" });
      return;
    }
    if (!testModel) {
      setCloudProbeMsg({ text: "请先选择或填写一个模型名称", type: "error" });
      return;
    }

    setIsTestingCloudConnection(true);
    setCloudProbeMsg(null);
    setCloudConnectionStatus(null);

    try {
      const headers = buildCloudHeaders(cloudProtocol, draftCloudConfig.apiKey || "", true, draftCloudConfig.customHeaders);
      let effectiveApiFormat = cloudApiFormat;
      let payload: unknown = null;
      let successfulResponsesMode: string | null = null;
      const probeMessages = [{ role: "user", content: "你好，请只回复 ok" }];

      const sendJsonProbe = async (url: string, body: Record<string, unknown>, stage: "base" | "advanced", mode?: string | null) => {
        let lastError: Error | null = null;
        console.log("[cloud-test] probe request", JSON.stringify({
          stage,
          url,
          model: body.model,
          mode: mode ?? null,
          hasInstructions: typeof body.instructions === "string" && body.instructions.length > 0,
          inputType: Array.isArray(body.input)
            ? body.input[0] && typeof body.input[0] === "object" && Array.isArray(body.input[0].content)
              ? "responses_input_array"
              : "responses_message_array"
            : typeof body.input,
          hasStoreFalse: body.store === false,
          reasoningEffort: typeof body.reasoning === "object" && body.reasoning && "effort" in body.reasoning
            ? body.reasoning.effort
            : null,
          hasMessages: Array.isArray(body.messages),
          stream: body.stream,
        }));

        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            const raw = await invoke<string>("proxy_request", {
              url,
              method: "POST",
              headers,
              body: JSON.stringify(body),
            });
            return JSON.parse(raw);
          } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err);
            lastError = err instanceof Error ? err : new Error(errMsg);
            if (!isRetryableCloudErrorMessage(errMsg) || attempt >= 2) {
              throw lastError;
            }
            await new Promise((resolve) => setTimeout(resolve, 350 * (attempt + 1)));
          }
        }

        throw lastError ?? new Error("Cloud probe failed without a concrete error.");
      };

      const runResponsesProbe = async (includeAdvanced: boolean, preferredMode?: string | null) => {
        const url = buildCloudMessagesApiUrl(endpoint, cloudProtocol, "responses");
        let candidates = buildOpenAiResponsesProbeRequestCandidates({
          messages: probeMessages,
          model: testModel,
          includeAdvanced,
          disableResponseStorage: draftCloudConfig.disableResponseStorage,
          reasoningEffort: draftCloudConfig.reasoningEffort,
        });
        if (preferredMode) {
          candidates = [
            ...candidates.filter((candidate) => candidate.mode === preferredMode),
            ...candidates.filter((candidate) => candidate.mode !== preferredMode),
          ];
        }

        let lastCandidateError = null;
        for (const candidate of candidates) {
          try {
            return {
              payload: await sendJsonProbe(url, candidate.body, includeAdvanced ? "advanced" : "base", candidate.mode),
              mode: candidate.mode,
            };
          } catch (candidateErr) {
            lastCandidateError = candidateErr;
            const errMsg = candidateErr instanceof Error ? candidateErr.message : String(candidateErr);
            if (!isProviderCompatibilityErrorMessage(errMsg) && !isRetryableCloudErrorMessage(errMsg)) throw candidateErr;
          }
        }

        throw lastCandidateError ?? new Error("Responses probe failed without a compatibility fallback result.");
      };

      const runOpenAiBaseProbe = async () => {
        const openAiProbeFormats = [cloudApiFormat, cloudApiFormat === "responses" ? "chat_completions" : "responses"];
        let lastError = null;

        for (const probeFormat of openAiProbeFormats) {
          try {
            if (probeFormat === "responses") {
              const result = await runResponsesProbe(false);
              return {
                payload: result.payload,
                effectiveApiFormat: probeFormat,
                responsesMode: result.mode,
              };
            }

            const url = buildCloudMessagesApiUrl(endpoint, cloudProtocol, probeFormat);
            return {
              payload: await sendJsonProbe(url, {
                model: testModel,
                messages: probeMessages,
                stream: false,
                max_tokens: 32,
              }, "base", "chat_completions"),
              effectiveApiFormat: probeFormat,
              responsesMode: null,
            };
          } catch (probeErr) {
            lastError = probeErr;
            const errMsg = probeErr instanceof Error ? probeErr.message : String(probeErr);
            if (!isProviderCompatibilityErrorMessage(errMsg) && !isRetryableCloudErrorMessage(errMsg)) throw probeErr;
          }
        }

        throw lastError ?? new Error("OpenAI probe failed without a compatibility fallback result.");
      };

      if (cloudProtocol === "anthropic") {
        const url = buildCloudMessagesApiUrl(endpoint, cloudProtocol, cloudApiFormat);
        payload = await sendJsonProbe(url, buildAnthropicRequestBody({
          messages: probeMessages,
          model: testModel,
          maxTokens: 32,
          stream: false,
          temperature: draftCloudConfig.temperature ?? 0.2,
          topP: draftCloudConfig.topP ?? 0.95,
        }), "base", "anthropic");
      } else {
        const result = await runOpenAiBaseProbe();
        payload = result.payload;
        effectiveApiFormat = result.effectiveApiFormat;
        successfulResponsesMode = result.responsesMode;
      }

      if (cloudDraftServer && !isSameCloudConnectionTarget(cloudDraftServerRef.current, targetServer)) return;

      if (cloudProtocol === "openai" && effectiveApiFormat !== cloudApiFormat) {
        updateCloudDraftServer({ apiFormat: effectiveApiFormat });
      }
      if (cloudDraftServer) {
        confirmCloudModelSelection(testModel, {
          ...cloudDraftServer,
          apiFormat: effectiveApiFormat,
          model: testModel,
        });
      }

      const reply = cloudProtocol === "anthropic"
        ? extractAnthropicResponseText(payload).trim()
        : extractOpenAiResponseText(payload, effectiveApiFormat).trim();
      const switchedText = cloudProtocol === "openai" && effectiveApiFormat !== cloudApiFormat
        ? `，已自动切换到 ${effectiveApiFormat === "responses" ? "Responses API" : "Chat Completions"}`
        : "";
      const statusFingerprint = buildCloudConnectionFingerprint({
        ...(targetServer || draftCloudConfig),
        apiFormat: effectiveApiFormat,
        model: testModel,
      }, effectiveApiFormat, testModel);

      setCloudConnectionStatus({
        fingerprint: statusFingerprint,
        model: testModel,
        text: `已连通 ${testModel}${switchedText}`,
      });

      setCloudProbeMsg({
        text: reply
          ? `基础连通成功，${testModel} 返回：${reply.slice(0, 120)}${switchedText}。`
          : `基础连通成功，${testModel} 已返回有效响应${switchedText}。`,
        type: "success",
      });

      const shouldRunAdvancedProbe = cloudProtocol === "openai"
        && effectiveApiFormat === "responses"
        && (
          draftCloudConfig.disableResponseStorage !== false
          || normalizeOpenAiReasoningEffort(draftCloudConfig.reasoningEffort) !== "none"
        );

      if (shouldRunAdvancedProbe) {
        try {
          await runResponsesProbe(true, successfulResponsesMode);
          if (!cloudDraftServer || isSameCloudConnectionTarget(cloudDraftServerRef.current, {
            ...targetServer,
            apiFormat: effectiveApiFormat,
          })) {
            setCloudProbeMsg({ text: `高级参数也已通过：store/reasoning 与当前配置兼容。`, type: "success" });
          }
        } catch (advancedErr) {
          if (!cloudDraftServer || isSameCloudConnectionTarget(cloudDraftServerRef.current, {
            ...targetServer,
            apiFormat: effectiveApiFormat,
          })) {
            const errMsg = advancedErr instanceof Error ? advancedErr.message : String(advancedErr);
            setCloudProbeMsg({
              text: `基础连接可用，但 store/reasoning 高级参数未通过：${errMsg}。真实任务仍会按当前配置发送；如频繁波动，可把 Reasoning Effort 调低或设为 None。`,
              type: "warning",
            });
          }
        }
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      const protocolHint = cloudProtocol === "anthropic" && errMsg.includes("/v1/messages")
        ? " 当前这个云端服务看起来不支持 Anthropic /v1/messages，请切换到 OpenAI Compatible 再试。"
        : "";
      const retryHint = isRetryableCloudErrorMessage(errMsg)
        ? " 这通常是云端网关到上游模型的临时波动，应用已经自动重试过；稍后再试一次通常会恢复。"
        : "";
      setCloudProbeMsg({ text: "测试失败: " + errMsg + protocolHint + retryHint, type: "error" });
    } finally {
      setIsTestingCloudConnection(false);
    }
  }, [
    cloudApiFormat,
    cloudAvailableModels,
    cloudDraftServer,
    cloudProtocol,
    confirmCloudModelSelection,
    draftCloudConfig.apiKey,
    draftCloudConfig.customHeaders,
    draftCloudConfig.disableResponseStorage,
    draftCloudConfig.endpoint,
    draftCloudConfig.model,
    draftCloudConfig.reasoningEffort,
    draftCloudConfig.temperature,
    draftCloudConfig.topP,
    isTestingCloudConnection,
    updateCloudDraftServer,
  ]);

  // ── VRAM slider calculations ──
  const contextMin = 4096;
  const defaultContextMax = 131072;
  const absoluteContextMax = 262144;
  const availableGb = systemMemory?.available_bytes
    ? systemMemory.available_bytes / 1024 ** 3
    : systemMemory?.available_gb;
  const safeKvCacheGb = availableGb
    ? Math.max(0.5, Math.min(Math.max(availableGb - 1, 0.5), availableGb * 0.9))
    : null;
  const memoryBasedContextMax = safeKvCacheGb
    ? getTokensForKvCacheGb(safeKvCacheGb)
    : defaultContextMax;
  const contextMax = Math.max(contextMin, Math.min(absoluteContextMax, memoryBasedContextMax));
  const displayedContextLimit = Math.min(config.local.contextLimit, contextMax);
  const contextRatio = (displayedContextLimit - contextMin) / Math.max(1, contextMax - contextMin);
  const pressure = getPressureColor(contextRatio);
  const vramInfo = getVramEstimate(displayedContextLimit);
  const maxTokensAtMax = contextMax;
  const tokenReduction = Math.max(0, Math.round((1 - displayedContextLimit / maxTokensAtMax) * 100));
  const maxVramInfo = getVramEstimate(contextMax);
  const compressionLabel = contextRatio < 0.3 ? "省显存" : contextRatio < 0.7 ? "均衡" : "长上下文";
  const compressionHint = contextRatio < 0.3
    ? "更早压缩，适合显存紧张"
    : contextRatio < 0.7
      ? "上下文与显存占用折中"
      : "更晚压缩，保留更多历史";
  const vramGb = vramInfo.value / 1024;
  const vramRatio = safeKvCacheGb ? Math.min(vramGb / safeKvCacheGb, 1) : Math.min(vramGb / 32, 1);

  useEffect(() => {
    if (!systemMemory || config.local.contextLimit <= contextMax) return;
    setConfig({ ...config, local: { ...config.local, contextLimit: contextMax } });
  }, [config, contextMax, setConfig, systemMemory]);

  // ── Context tab content (shared component) ──
  const contextTabContent = (
    <div className="space-y-6">
      <h3 className="text-[13px] font-bold text-[#a1a1aa] uppercase tracking-wider">{t.contextSetup}</h3>

      {/* Header row */}
      <div className="flex items-start justify-between mb-3">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <span style={{ color: pressure.main }} className="text-[14px]">⚡</span>
            <label className="text-[13px] font-bold text-[#e4e4e7]">{t.contextLimit}</label>
          </div>
          <p className="text-[11px] text-[#a1a1aa] leading-relaxed max-w-[420px]">{t.contextLimitDesc}</p>
        </div>
        <div className="text-right">
          <span className="block text-[11px] font-bold text-[#a1a1aa] mb-0.5">{compressionLabel}</span>
          <span className="font-mono text-[22px] font-bold" style={{ color: pressure.main }}>
            {Math.round(contextRatio * 100)}%
          </span>
          <p className="text-[10px] text-[#71717a]">{compressionHint}</p>
        </div>
      </div>

      {/* Gradient slider */}
      <div className="relative mb-2">
        <input
          type="range" min={contextMin} max={contextMax} step="4096"
          value={displayedContextLimit}
          onChange={(e) => setConfig({ ...config, local: { ...config.local, contextLimit: parseInt(e.target.value) } })}
          className="w-full cursor-pointer vram-gradient-slider"
          style={{ '--slider-pct': `${contextRatio * 100}%` } as React.CSSProperties}
        />
      </div>

      {/* Zone labels */}
      <div className="flex justify-between text-[10px] font-bold uppercase tracking-wider mb-4">
        <span style={{ color: contextRatio < 0.3 ? '#60a5fa' : '#3f3f46' }}>省显存 / 更早压缩</span>
        <span style={{ color: contextRatio >= 0.3 && contextRatio < 0.7 ? '#a78bfa' : '#3f3f46' }}>均衡</span>
        <span style={{ color: contextRatio >= 0.7 ? '#f97316' : '#3f3f46' }}>长上下文 / 更晚压缩</span>
      </div>

      {/* Stats panel */}
      <div className="bg-[#000000] border border-[#27272a] rounded-lg p-4 shadow-inner">
        <div className="flex items-center justify-between gap-4">
          {/* Left: Max Tokens */}
          <div className="flex-1">
            <p className="text-[10px] text-[#71717a] uppercase tracking-wider mb-1">压缩触发阈值 (Token)</p>
            <div className="flex items-center gap-2">
              <span className="font-mono text-[16px] font-bold text-[#86d9a3]">
                ~ {displayedContextLimit.toLocaleString()}
              </span>
              {tokenReduction > 0 && (
                <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-[#0f2e0f] text-[#86d9a3] border border-[#1a3e1a]">
                  -{tokenReduction}%
                </span>
              )}
            </div>
          </div>

          {/* Divider */}
          <div className="w-px h-10 bg-[#27272a]" />

          {/* Right: Est. VRAM */}
          <div className="flex-1">
            <p className="text-[10px] text-[#71717a] uppercase tracking-wider mb-1">预估上下文显存</p>
            <div className="flex items-center gap-2.5">
              <span className="font-mono text-[16px] font-bold" style={{ color: pressure.main }}>
                {vramInfo.text}
              </span>
              <div className="flex-1 max-w-[80px] h-2 bg-[#18181b] rounded-full overflow-hidden border border-[#27272a]">
                <div
                  className="h-full rounded-full transition-all duration-300"
                  style={{
                    width: `${vramRatio * 100}%`,
                    background: `linear-gradient(90deg, ${pressure.main}, ${pressure.main}88)`,
                  }}
                />
              </div>
            </div>
            <p className="mt-1 text-[10px] text-[#71717a]">
              当前上限约 {contextMax.toLocaleString()} Token
            </p>
          </div>
        </div>

        {/* Device memory bar */}
        {systemMemory && (
          <div className="mt-3 pt-3 border-t border-[#18181b] flex items-center gap-2.5">
            <span className="text-[10px] text-[#3f3f46]">🖥</span>
            <div className="flex-1">
              <div className="flex items-center justify-between mb-1">
                <span className="text-[10px] text-[#71717a]">设备内存</span>
                <span className="text-[10px] font-mono text-[#a1a1aa]">
                  {systemMemory.available_gb} / {systemMemory.total_gb} GB 可用
                </span>
              </div>
              <div className="h-1.5 bg-[#18181b] rounded-full overflow-hidden border border-[#27272a]">
                <div
                  className="h-full rounded-full transition-all duration-500"
                  style={{
                    width: `${(1 - systemMemory.available_gb / systemMemory.total_gb) * 100}%`,
                    background: `linear-gradient(90deg, #22c55e 0%, ${pressure.main} 100%)`,
                  }}
                />
            </div>
            <p className="mt-1 text-[10px] text-[#71717a]">
              满格约 {maxVramInfo.text}{safeKvCacheGb ? "，已按当前可用内存预留安全余量" : ""}
            </p>
          </div>
        </div>
        )}
      </div>

      <p className="text-[11px] text-[#71717a] italic">{t.vramNote}</p>

      {/* Tip */}
      <div className="p-3 bg-[#000000] border border-[#27272a] rounded-md">
        <p className="text-[11px] text-[#71717a] leading-relaxed">
          💡 <span className="text-[#a1a1aa]">提示</span>：此设置用于本地模型的背景压缩与上下文窗口。满格会参考当前可用内存动态计算，并预留约 1GB / 10% 安全余量。
        </p>
      </div>
    </div>
  );

  return isOpen ? (
    <div className="absolute inset-0 bg-black/80 flex items-center justify-center z-50 p-4 backdrop-blur-sm">
      <div
        className="bg-[#09090b] border border-[#27272a] rounded-xl shadow-2xl w-[min(1170px,94vw)] flex flex-col overflow-hidden"
        style={{ height: "min(920px, calc(100vh - 32px))", maxHeight: "calc(100vh - 32px)" }}
      >
        <div className="shrink-0 px-5 py-4 border-b border-[#27272a] flex items-center justify-between bg-[#000000]">
          <h2 className="text-base font-bold text-white flex items-center gap-2"><IconSettings className="w-5 h-5" /> {t.settings}</h2>
          <button onClick={onClose} className="text-[#a1a1aa] hover:text-white transition-colors"><IconClose className="w-4 h-4" /></button>
        </div>

        <div className="flex min-h-0 flex-1">
          <div className="w-52 shrink-0 overflow-y-auto border-r border-[#27272a] bg-[#000000] p-2 flex flex-col gap-1">
            <button onClick={() => setSettingsTab('general')} className={`text-left px-4 py-2.5 text-[13px] font-medium rounded-md transition-colors ${settingsTab === 'general' ? 'theme-bg shadow-sm' : 'text-[#a1a1aa] hover:text-[#e4e4e7] hover:bg-[#18181b]'}`}>{t.general}</button>
            <button onClick={() => setSettingsTab('local')} className={`text-left px-4 py-2.5 text-[13px] font-medium rounded-md transition-colors ${settingsTab === 'local' ? 'theme-bg shadow-sm' : 'text-[#a1a1aa] hover:text-[#e4e4e7] hover:bg-[#18181b]'}`}>{t.localSetup}</button>
            <button onClick={() => setSettingsTab('cloud')} className={`text-left px-4 py-2.5 text-[13px] font-medium rounded-md transition-colors ${settingsTab === 'cloud' ? 'theme-bg shadow-sm' : 'text-[#a1a1aa] hover:text-[#e4e4e7] hover:bg-[#18181b]'}`}>{t.cloudSetup}</button>
            <button onClick={() => setSettingsTab('context')} className={`text-left px-4 py-2.5 text-[13px] font-medium rounded-md transition-colors ${settingsTab === 'context' ? 'theme-bg shadow-sm' : 'text-[#a1a1aa] hover:text-[#e4e4e7] hover:bg-[#18181b]'}`}>{t.contextSetup}</button>
            <button onClick={() => setSettingsTab('mcp')} className={`text-left px-4 py-2.5 text-[13px] font-medium rounded-md transition-colors ${settingsTab === 'mcp' ? 'theme-bg shadow-sm' : 'text-[#a1a1aa] hover:text-[#e4e4e7] hover:bg-[#18181b]'}`}>MCP 服务器</button>
            <button onClick={() => setSettingsTab('im')} className={`text-left px-4 py-2.5 text-[13px] font-medium rounded-md transition-colors ${settingsTab === 'im' ? 'theme-bg shadow-sm' : 'text-[#a1a1aa] hover:text-[#e4e4e7] hover:bg-[#18181b]'}`}>{t.imAdapters}</button>
            <button onClick={() => setSettingsTab('data')} className={`text-left px-4 py-2.5 text-[13px] font-medium rounded-md transition-colors ${settingsTab === 'data' ? 'theme-bg shadow-sm' : 'text-[#a1a1aa] hover:text-[#e4e4e7] hover:bg-[#18181b]'}`}>{t.dataManagement}</button>
            <button onClick={() => setSettingsTab('debug')} className={`text-left px-4 py-2.5 text-[13px] font-medium rounded-md transition-colors ${settingsTab === 'debug' ? 'theme-bg shadow-sm' : 'text-[#a1a1aa] hover:text-[#e4e4e7] hover:bg-[#18181b]'}`}>{t.debugLog}</button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto bg-[#09090b] p-6 pb-8">

            {/* GENERAL SETTINGS + THEME */}
            {settingsTab === 'general' && (
              <div className="space-y-6">
                <div className="flex items-center justify-between"><h3 className="text-[13px] font-bold text-[#a1a1aa] uppercase tracking-wider">{t.general}</h3></div>
                <div>
                  <label className="block text-[13px] font-bold text-[#e4e4e7] mb-2">Display Language</label>
                  <select value={config.language} onChange={(e) => setConfig({ ...config, language: e.target.value })} className="w-full bg-[#000000] border border-[#27272a] rounded-md p-2.5 text-[14px] text-white focus:outline-none theme-ring transition-all cursor-pointer">
                    <option value="en">English</option><option value="zh">简体中文</option>
                  </select>
                </div>

                {/* THEME COLOR PICKER */}
                <div className="pt-4 border-t border-[#27272a]">
                  <label className="block text-[13px] font-bold text-[#e4e4e7] mb-1.5">{t.themeColor}</label>
                  <p className="text-[12px] text-[#a1a1aa] mb-4">{t.themeDesc}</p>
                  <div className="flex flex-wrap gap-3">
                    {Object.entries(THEMES).map(([key, theme]) => (
                      <button
                        key={key}
                        onClick={() => setConfig({ ...config, theme: key })}
                        aria-label={theme.name}
                        title={theme.name}
                        className={`h-7 w-12 rounded-full cursor-pointer ${
                          config.theme === key
                            ? 'scale-105 ring-2 ring-[#f4f4f5] ring-offset-2 ring-offset-[#09090b] shadow-lg'
                            : ''
                        }`}
                        style={{ backgroundColor: theme.accent }}
                      />
                    ))}
                  </div>
                </div>

                {/* THEME MODE TOGGLE */}
                <div className="pt-4 border-t border-[#27272a]">
                  <label className="block text-[13px] font-bold text-[#e4e4e7] mb-1.5">{t.themeMode}</label>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => setConfig({ ...config, themeMode: "dark" })}
                      className={`flex items-center gap-2 px-4 py-2 text-[12px] font-bold rounded-md border transition-colors ${
                        config.themeMode !== "light"
                          ? "theme-subtle-bg theme-subtle-border theme-text"
                          : "bg-[#000000] border-[#27272a] text-[#a1a1aa] hover:text-white"
                      }`}
                    >
                      <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" /></svg>
                      {t.themeModeDark}
                    </button>
                    <button
                      onClick={() => setConfig({ ...config, themeMode: "light" })}
                      className={`flex items-center gap-2 px-4 py-2 text-[12px] font-bold rounded-md border transition-colors ${
                        config.themeMode === "light"
                          ? "theme-subtle-bg theme-subtle-border theme-text"
                          : "bg-[#000000] border-[#27272a] text-[#a1a1aa] hover:text-white"
                      }`}
                    >
                      <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="5" /><line x1="12" y1="1" x2="12" y2="3" /><line x1="12" y1="21" x2="12" y2="23" /><line x1="4.22" y1="4.22" x2="5.64" y2="5.64" /><line x1="18.36" y1="18.36" x2="19.78" y2="19.78" /><line x1="1" y1="12" x2="3" y2="12" /><line x1="21" y1="12" x2="23" y2="12" /><line x1="4.22" y1="19.78" x2="5.64" y2="18.36" /><line x1="18.36" y1="5.64" x2="19.78" y2="4.22" /></svg>
                      {t.themeModeLight}
                    </button>
                  </div>
                </div>

                {/* CHAT FONT SIZE */}
                <div className="pt-4 border-t border-[#27272a]">
                  <div className="flex items-center justify-between mb-1.5">
                    <label className="text-[13px] font-bold text-[#e4e4e7]">{t.chatFontSize}</label>
                    <span className="text-[12px] font-mono theme-subtle-bg px-2 py-0.5 rounded border theme-subtle-border">{config.chatFontSize ?? 13} px</span>
                  </div>
                  <p className="text-[12px] text-[#a1a1aa] mb-3">{t.chatFontSizeDesc}</p>
                  <input
                    type="range" min={10} max={20} step={1}
                    value={config.chatFontSize ?? 13}
                    onChange={(e) => setConfig({ ...config, chatFontSize: parseInt(e.target.value) })}
                    className="w-full theme-slider cursor-pointer"
                  />
                  <div className="flex justify-between text-[11px] text-[#3f3f46] font-mono mt-1">
                    <span>10</span><span>13</span><span>16</span><span>20</span>
                  </div>
                </div>

                {/* SESSION RECORDING */}
                <div className="pt-4 border-t border-[#27272a]">
                  <label className="flex cursor-pointer items-start gap-3">
                    <input
                      type="checkbox"
                      checked={config.sessionRecordingEnabled !== false}
                      onChange={(e) => setConfig({ ...config, sessionRecordingEnabled: e.target.checked })}
                      className="mt-1"
                    />
                    <span>
                      <span className="block text-[13px] font-bold text-[#e4e4e7]">{t.sessionRecording}</span>
                      <span className="mt-1 block text-[12px] leading-relaxed text-[#a1a1aa]">{t.sessionRecordingDesc}</span>
                    </span>
                  </label>
                </div>
              </div>
            )}

            {/* LOCAL AI SETTINGS */}
            {settingsTab === 'local' && (
              <div className="space-y-6">
                <div className="flex items-center justify-between">
                  <h3 className="text-[13px] font-bold text-[#a1a1aa] uppercase tracking-wider">{t.localSetup}</h3>
                  <button onClick={() => setConfig({ ...config, activeProfile: 'local' })} className={`text-[11px] px-2.5 py-1.5 rounded border uppercase font-bold tracking-wider transition-colors ${config.activeProfile === 'local' ? 'theme-subtle-bg theme-subtle-border theme-text' : 'bg-[#18181b] text-[#a1a1aa] border-transparent hover:text-white'}`}>
                    {config.activeProfile === 'local' ? 'Active Profile' : 'Set as Active'}
                  </button>
                </div>
                <div>
                  <label className="block text-[13px] font-bold text-[#e4e4e7] mb-2">Provider Engine</label>
                  <select value={config.local.provider} onChange={handleProviderChange} className="w-full bg-[#000000] border border-[#27272a] rounded-md p-2.5 text-[14px] text-white focus:outline-none theme-ring cursor-pointer">
                    <option value="LM Studio">LM Studio</option>
                    <option value="Ollama">Ollama</option>
                    <option value="OMLX">OMLX (MLX for Mac)</option>
                  </select>
                </div>
                <div>
                  <label className="block text-[13px] font-bold text-[#e4e4e7] mb-2">API Endpoint</label>
                  <input type="text" value={config.local.endpoint} onChange={(e) => setConfig({ ...config, local: { ...config.local, endpoint: e.target.value } })} className="w-full bg-[#000000] border border-[#27272a] rounded-md p-2.5 text-[14px] text-white focus:outline-none theme-ring font-mono" />
                </div>
                {config.local.provider === "OMLX" && (
                  <div>
                    <label className="block text-[13px] font-bold text-[#e4e4e7] mb-2">API Key <span className="text-[#71717a] font-normal">(可选，OMLX 服务鉴权用)</span></label>
                    <input
                      type="password"
                      value={config.local.apiKey || ""}
                      onChange={(e) => setConfig({ ...config, local: { ...config.local, apiKey: e.target.value } })}
                      placeholder="留空则不发送鉴权头"
                      className="w-full bg-[#000000] border border-[#27272a] rounded-md p-2.5 text-[14px] text-white focus:outline-none theme-ring font-mono placeholder:text-[#3f3f46]"
                    />
                  </div>
                )}
                {/* Auto-detected model selector */}
                <div>
                  <label className="block text-[13px] font-bold text-[#e4e4e7] mb-2">Local Model</label>
                  <div className="flex gap-2">
                    <select
                      value={config.local.model || ""}
                      onChange={(e) => setConfig({ ...config, local: { ...config.local, model: e.target.value } })}
                      disabled={isFetchingModels}
                      className="flex-1 bg-[#000000] border border-[#27272a] rounded-md p-2.5 text-[14px] text-white focus:outline-none theme-ring transition-colors cursor-pointer"
                    >
                      {isFetchingModels ? (
                        <option value="">正在扫描模型...</option>
                      ) : availableModels.length === 0 ? (
                        <option value="">未发现模型 — 请先启动本地推理服务</option>
                      ) : (
                        availableModels.map(m => (<option key={m} value={m}>{m}</option>))
                      )}
                    </select>
                    <button
                      onClick={() => fetchModels()}
                      disabled={isFetchingModels}
                      className="px-3 py-2 text-[12px] font-bold bg-[#18181b] text-[#a1a1aa] hover:text-white border border-[#27272a] rounded-md transition-colors shrink-0 disabled:opacity-50"
                    >
                      {isFetchingModels ? '扫描中...' : '扫描'}
                    </button>
                  </div>
                  {localFetchMsg && (
                    <p className={`mt-2 text-[12px] ${localFetchMsg.type === 'error' ? 'text-[#f48771]' : 'text-[#86d9a3]'}`}>
                      {localFetchMsg.text}
                    </p>
                  )}
                </div>
              </div>
            )}

            {/* CONTEXT / COMPRESSION SETTINGS */}
            {settingsTab === 'context' && contextTabContent}

            {/* MCP SERVER SETTINGS */}
            {settingsTab === 'mcp' && <McpServerPanel
              mcpServers={mcpServers}
              setMcpServers={setMcpServers}
              mcpDiscoveredTools={mcpDiscoveredTools}
              setMcpDiscoveredTools={setMcpDiscoveredTools}
            />}

            {/* DATA MANAGEMENT */}
            {settingsTab === 'data' && <DataManagerPanel t={t} />}

            {/* DEBUG LOG */}
            {settingsTab === 'debug' && <DebugLogPanel t={t} />}

            {/* IM ADAPTER SETTINGS */}
            {settingsTab === 'im' && <FeishuAdapterPanel config={config} setConfig={setConfig} t={t} />}

            {/* CLOUDED API SETTINGS */}
            {settingsTab === 'cloud' && (
              <div className="space-y-5">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <h3 className="text-[13px] font-bold text-[#a1a1aa] uppercase tracking-wider">{t.cloudSetup}</h3>
                    <p className="mt-1 text-[11.5px] text-[#71717a]">管理多个云端服务器配置。新建或编辑后点击保存，模型列表只会在点击刷新时获取。</p>
                  </div>
                  <button onClick={() => setConfig({ ...config, activeProfile: 'cloud' })} className={`text-[11px] px-2.5 py-1.5 rounded border uppercase font-bold tracking-wider transition-colors ${config.activeProfile === 'cloud' ? 'theme-subtle-bg theme-subtle-border theme-text' : 'bg-[#18181b] text-[#a1a1aa] border-transparent hover:text-white'}`}>
                    {config.activeProfile === 'cloud' ? 'Active Profile' : 'Set as Active'}
                  </button>
                </div>

                <section data-testid="cloud-model-panel" className="rounded-lg border border-[#27272a] bg-[#000000] p-4">
                  {cloudDraftServer ? (
                    <>
                      <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
                        <div className="min-w-0">
                          <label className="block text-[13px] font-bold text-[#e4e4e7]">Model Name</label>
                          <p className="mt-1 text-[11.5px] text-[#71717a]">
                            当前服务器：<span className="text-[#a1a1aa]">{cloudDraftServer.name || "未命名服务器"}</span>
                            {cloudDraftMode === "new" && <span className="ml-2 rounded border border-[#3f3f46] px-1.5 py-0.5 text-[9px] font-bold uppercase text-[#a1a1aa]">未保存</span>}
                          </p>
                        </div>
                        {cloudAvailableModels.length > 0 && (
                          <button
                            data-testid="cloud-model-mode-toggle"
                            onClick={() => {
                              if (cloudModelInputMode === "manual") {
                                const nextModel = cloudAvailableModels.includes(draftCloudConfig.model)
                                  ? draftCloudConfig.model
                                  : cloudAvailableModels[0];
                                confirmCloudModelSelection(nextModel);
                                setCloudModelInputMode("select");
                                return;
                              }
                              setCloudModelInputMode("manual");
                            }}
                            className="text-[11px] font-bold text-[#a1a1aa] transition-colors hover:text-white"
                          >
                            {cloudModelInputMode === "select" ? "手动输入" : "下拉选择"}
                          </button>
                        )}
                      </div>
                      <div className="flex flex-col gap-2 sm:flex-row">
                        {cloudAvailableModels.length > 0 && cloudModelInputMode === "select" ? (
                          <select
                            data-testid="cloud-model-select"
                            value={draftCloudConfig.model || ""}
                            onChange={(e) => confirmCloudModelSelection(e.target.value)}
                            disabled={isFetchingCloudModels}
                            className="min-w-0 flex-1 rounded-md border border-[#27272a] bg-[#000000] p-2.5 text-[14px] text-white outline-none theme-ring transition-colors"
                          >
                            {cloudAvailableModels.map((model) => (
                              <option key={model} value={model}>{model}</option>
                            ))}
                          </select>
                        ) : (
                          <input
                            data-testid="cloud-model-input"
                            type="text"
                            value={draftCloudConfig.model || ""}
                            onChange={(e) => confirmCloudModelSelection(e.target.value)}
                            placeholder={cloudModelPlaceholder}
                            className="min-w-0 flex-1 rounded-md border border-[#27272a] bg-[#000000] p-2.5 font-mono text-[14px] text-white outline-none theme-ring placeholder:text-[#3f3f46]"
                          />
                        )}
                        <button
                          data-testid="cloud-model-refresh"
                          onClick={() => refreshCloudModels()}
                          disabled={isFetchingCloudModels}
                          className="shrink-0 rounded-md border border-[#27272a] bg-[#18181b] px-3 py-2 text-[12px] font-bold text-[#a1a1aa] transition-colors hover:text-white disabled:opacity-50"
                        >{isFetchingCloudModels ? '刷新中...' : '刷新'}</button>
                        <button
                          data-testid="cloud-model-test"
                          onClick={testCloudConnection}
                          disabled={isTestingCloudConnection}
                          className="shrink-0 rounded-md border border-[#27272a] bg-[#18181b] px-3 py-2 text-[12px] font-bold text-[#a1a1aa] transition-colors hover:text-white disabled:opacity-50"
                        >{isTestingCloudConnection ? '测试中...' : '测试'}</button>
                      </div>
                      {cloudAvailableModels.length > 0 && (
                        <p data-testid="cloud-model-fetched-count" className="mt-2 text-[11px] text-[#71717a]">已拉取 {cloudAvailableModels.length} 个模型</p>
                      )}
                      {activeCloudConnectionStatus && (
                        <p data-testid="cloud-model-connected-status" className="mt-2 flex items-center gap-1.5 text-[12px] font-medium text-[#86d9a3]">
                          <IconCheck className="h-3.5 w-3.5" />
                          <span>{activeCloudConnectionStatus.text}</span>
                        </p>
                      )}
                      {cloudFetchMsg && <p className={`mt-2 text-[12px] ${cloudFetchMsg.type === 'error' ? 'text-[#f48771]' : 'text-[#86d9a3]'}`}>{cloudFetchMsg.text}</p>}
                      {cloudProbeMsg && <p className={`mt-2 text-[12px] ${cloudProbeMsg.type === 'error' ? 'text-[#f48771]' : cloudProbeMsg.type === 'warning' ? 'text-[#fbbf24]' : 'text-[#86d9a3]'}`}>{cloudProbeMsg.text}</p>}
                    </>
                  ) : (
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                      <div className="flex min-w-0 items-start gap-3">
                        <div className="flex h-9 w-9 items-center justify-center rounded-md border border-[#27272a] bg-[#09090b] text-[#71717a]">
                          <IconCloud className="h-4 w-4" />
                        </div>
                        <div className="min-w-0">
                          <p className="text-[13px] font-bold text-[#e4e4e7]">还没有云端服务器</p>
                          <p className="mt-1 text-[11.5px] text-[#71717a]">从左侧新增服务器后，再在这里手动刷新模型列表。</p>
                        </div>
                      </div>
                      <button
                        onClick={addCloudServer}
                        className="inline-flex items-center justify-center gap-2 rounded-md theme-bg theme-bg-hover px-3 py-2 text-[12px] font-bold text-white transition-colors"
                      >
                        <IconPlus className="h-3.5 w-3.5" /> 新增服务器
                      </button>
                    </div>
                  )}
                </section>

                <div className="grid gap-4 lg:grid-cols-[280px_minmax(0,1fr)]">
                  <aside className="min-w-0 rounded-lg border border-[#27272a] bg-[#000000] p-3">
                    <div className="mb-3 flex items-center justify-between gap-2">
                      <div className="min-w-0">
                        <div className="text-[12px] font-bold uppercase tracking-wider text-[#a1a1aa]">服务器</div>
                        <div className="text-[11px] text-[#71717a]">{cloudServers.length} 个配置</div>
                      </div>
                      <button
                        data-testid="cloud-server-add"
                        onClick={addCloudServer}
                        className="flex h-8 w-8 items-center justify-center rounded-md border border-[#27272a] bg-[#18181b] text-[#e4e4e7] transition-colors hover:border-[#3f3f46]"
                        title="新增服务器"
                      >
                        <IconPlus className="h-4 w-4" />
                      </button>
                    </div>
                    <input
                      data-testid="cloud-server-search"
                      value={cloudServerSearch}
                      onChange={(e) => setCloudServerSearch(e.target.value)}
                      placeholder="搜索名称、Endpoint、模型"
                      className="mb-3 w-full rounded-md border border-[#27272a] bg-[#09090b] p-2 text-[12px] text-white outline-none theme-ring placeholder:text-[#3f3f46]"
                    />
                    <div data-testid="cloud-server-list" className="max-h-[420px] space-y-2 overflow-y-auto pr-1">
                      {visibleCloudServers.length === 0 ? (
                        <div className="rounded-md border border-dashed border-[#27272a] p-4 text-center text-[12px] text-[#71717a]">
                          {cloudServers.length === 0 && !cloudDraftServer ? "暂无服务器配置" : "没有匹配的服务器"}
                        </div>
                      ) : (
                        visibleCloudServers.map((server) => {
                          const isSelectedServer = cloudDraftServer?.id === server.id;
                          const isActiveServer = server.id === activeCloudServerId;
                          const isUnsavedServer = cloudDraftMode === "new" && cloudDraftServer?.id === server.id && !cloudServers.some((saved) => saved.id === server.id);
                          return (
                            <div
                              key={server.id}
                              data-testid="cloud-server-item"
                              role="button"
                              tabIndex={0}
                              onClick={() => selectCloudServer(server.id)}
                              onKeyDown={(e) => {
                                if (e.key === "Enter" || e.key === " ") {
                                  e.preventDefault();
                                  selectCloudServer(server.id);
                                }
                              }}
                              className={`group w-full rounded-md border p-3 text-left transition-colors ${isSelectedServer ? "theme-subtle-bg theme-subtle-border" : "border-[#27272a] bg-[#09090b] hover:border-[#3f3f46]"}`}
                            >
                              <div className="flex items-start gap-2">
                                <IconCloud className={`mt-0.5 h-4 w-4 ${isSelectedServer ? "theme-text" : "text-[#71717a]"}`} />
                                <div className="min-w-0 flex-1">
                                  <div className="flex items-center gap-2">
                                    <span className="truncate text-[13px] font-bold text-[#e4e4e7]">{server.name || (isUnsavedServer ? "未保存服务器" : "未命名服务器")}</span>
                                    {isActiveServer && <span className="shrink-0 rounded border theme-subtle-border px-1.5 py-0.5 text-[9px] font-bold uppercase theme-text">Active</span>}
                                    {isUnsavedServer && <span className="shrink-0 rounded border border-[#3f3f46] px-1.5 py-0.5 text-[9px] font-bold uppercase text-[#a1a1aa]">未保存</span>}
                                  </div>
                                  <div className="mt-1 flex items-center gap-1.5">
                                    <span className="rounded bg-[#18181b] px-1.5 py-0.5 text-[9px] font-bold uppercase text-[#a1a1aa]">{normalizeCloudProtocol(server.protocol) === "anthropic" ? "Anthropic" : "OpenAI"}</span>
                                    {server.model && <span className="truncate text-[10px] text-[#71717a]">{server.model}</span>}
                                  </div>
                                  <div className="mt-1 truncate font-mono text-[10px] text-[#71717a]">{server.endpoint || "未填写 Endpoint"}</div>
                                </div>
                                <span
                                  role="button"
                                  tabIndex={0}
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    removeCloudServer(server.id);
                                  }}
                                  onKeyDown={(e) => {
                                    if (e.key === "Enter" || e.key === " ") {
                                      e.preventDefault();
                                      e.stopPropagation();
                                      removeCloudServer(server.id);
                                    }
                                  }}
                                  className="mt-0.5 rounded p-1 text-[#71717a] opacity-0 transition-colors hover:bg-[#181111] hover:text-[#fca5a5] group-hover:opacity-100"
                                  title="删除服务器"
                                >
                                  <IconTrash className="h-3.5 w-3.5" />
                                </span>
                              </div>
                            </div>
                          );
                        })
                      )}
                    </div>
                  </aside>

                  <div className="min-w-0 space-y-5">
                    {cloudDraftServer ? (
                      <>
                    <section className="rounded-lg border border-[#27272a] bg-[#000000] p-4">
                      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
                        <div>
                          <div className="text-[12px] font-bold uppercase tracking-wider text-[#a1a1aa]">服务器配置</div>
                          {cloudSaveMsg ? (
                            <p className={`mt-1 text-[11.5px] ${cloudSaveMsg.type === 'error' ? 'text-[#f48771]' : 'text-[#86d9a3]'}`}>{cloudSaveMsg.text}</p>
                          ) : hasCloudDraftChanges ? (
                            <p className="mt-1 text-[11.5px] text-[#facc15]">有未保存更改</p>
                          ) : (
                            <p className="mt-1 text-[11.5px] text-[#71717a]">当前服务器配置已保存</p>
                          )}
                        </div>
                        <button
                          data-testid="cloud-server-save"
                          onClick={saveCloudServer}
                          disabled={!canSaveCloudServer}
                          className="inline-flex items-center justify-center gap-2 rounded-md theme-bg theme-bg-hover px-3 py-2 text-[12px] font-bold text-white transition-colors disabled:cursor-not-allowed disabled:opacity-40"
                        >
                          <IconSave className="h-3.5 w-3.5" /> 保存
                        </button>
                      </div>
                      <div className="space-y-4">
                        <div>
                          <label className="mb-2 block text-[13px] font-bold text-[#e4e4e7]">Server Name</label>
                          <input
                            data-testid="cloud-server-name-input"
                            type="text"
                            value={cloudDraftServer.name ?? ""}
                            onChange={(e) => updateCloudDraftServer({ name: e.target.value })}
                            placeholder="例如 OpenAI / OpenRouter / 公司网关"
                            className="w-full rounded-md border border-[#27272a] bg-[#000000] p-2.5 text-[14px] text-white outline-none theme-ring placeholder:text-[#3f3f46]"
                          />
                        </div>

                        <div>
                          <label className="mb-2 block text-[13px] font-bold text-[#e4e4e7]">API Protocol</label>
                          <p className="mb-2 text-[11.5px] text-[#71717a]">选择云端服务遵循的协议格式。聚合平台通常走 OpenAI Compatible，Claude 原生接口走 Anthropic</p>
                          <select
                            value={cloudProtocol}
                            onChange={handleCloudProtocolChange}
                            className="w-full rounded-md border border-[#27272a] bg-[#000000] p-2.5 text-[14px] text-white outline-none theme-ring"
                          >
                            <option value="openai">OpenAI Compatible</option>
                            <option value="anthropic">Anthropic</option>
                          </select>
                        </div>

                        {cloudProtocol === "openai" && (
                          <div>
                            <label className="mb-2 block text-[13px] font-bold text-[#e4e4e7]">API Format</label>
                            <p className="mb-2 text-[11.5px] text-[#71717a]">弱兼容网关可先尝试 Chat Completions；如果服务像 Codex 一样使用 `wire_api = responses`，请切换到 Responses API</p>
                            <select
                              value={cloudApiFormat}
                              onChange={handleCloudApiFormatChange}
                              className="w-full rounded-md border border-[#27272a] bg-[#000000] p-2.5 text-[14px] text-white outline-none theme-ring"
                            >
                              <option value="chat_completions">OpenAI Chat Completions</option>
                              <option value="responses">OpenAI Responses API</option>
                            </select>
                          </div>
                        )}

                        <div>
                          <label className="mb-2 block text-[13px] font-bold text-[#e4e4e7]">API Endpoint</label>
                          <p className="mb-2 text-[11.5px] text-[#71717a]">{cloudEndpointHint}</p>
                          <input
                            data-testid="cloud-server-endpoint-input"
                            type="text"
                            value={draftCloudConfig.endpoint || ""}
                            onChange={(e) => {
                              updateCloudDraftServer({ endpoint: e.target.value }, { clearModels: true });
                            }}
                            placeholder={cloudEndpointPlaceholder}
                            className="w-full rounded-md border border-[#27272a] bg-[#000000] p-2.5 font-mono text-[14px] text-white outline-none theme-ring placeholder:text-[#3f3f46]"
                          />
                        </div>

                        <div>
                          <label className="mb-2 block text-[13px] font-bold text-[#e4e4e7]">API Key <span className="font-normal text-[#71717a]">(如服务不需要可留空)</span></label>
                          <p className="mb-2 text-[11.5px] text-[#71717a]">{cloudProtocol === "anthropic" ? "Anthropic 协议会使用 x-api-key 请求头" : "OpenAI 兼容协议会默认同时发送 Authorization: Bearer 和 x-api-key 请求头，以兼容更多聚合网关"}</p>
                          <input
                            data-testid="cloud-server-api-key-input"
                            type="password"
                            value={draftCloudConfig.apiKey || ""}
                            onChange={(e) => {
                              updateCloudDraftServer({ apiKey: e.target.value }, { clearModels: true });
                            }}
                            placeholder={cloudApiKeyPlaceholder}
                            className="w-full rounded-md border border-[#27272a] bg-[#000000] p-2.5 font-mono text-[14px] text-white outline-none theme-ring placeholder:text-[#3f3f46]"
                          />
                        </div>

                        <div>
                          <label className="mb-2 block text-[13px] font-bold text-[#e4e4e7]">Additional Headers (JSON) <span className="font-normal text-[#71717a]">(可选)</span></label>
                          <p className="mb-2 text-[11.5px] text-[#71717a]">需要厂商专用请求头时可填写 JSON 对象，或 [{'{'}"header","value"{'}'}] 数组，例如 {`{"HTTP-Referer":"https://example.com","X-Title":"MAIN"}`}</p>
                          <textarea
                            value={draftCloudConfig.customHeaders || ""}
                            onChange={(e) => {
                              updateCloudDraftServer({ customHeaders: e.target.value }, { clearModels: true });
                            }}
                            placeholder='{"HTTP-Referer":"https://example.com","X-Title":"MAIN"}'
                            className="min-h-[92px] w-full resize-y rounded-md border border-[#27272a] bg-[#000000] p-2.5 font-mono text-[13px] text-white outline-none theme-ring placeholder:text-[#3f3f46]"
                          />
                          {parsedCloudCustomHeaders.error ? (
                            <p className="mt-2 text-[12px] text-[#f48771]">{parsedCloudCustomHeaders.error}</p>
                          ) : (
                            <p className="mt-2 text-[11px] text-[#71717a]">当前将附加 {Object.keys(parsedCloudCustomHeaders.headers).length} 个自定义请求头</p>
                          )}
                        </div>
                      </div>
                    </section>

                    <section className="rounded-lg border border-[#27272a] bg-[#000000] p-4">
                      <div className="mb-4 text-[12px] font-bold uppercase tracking-wider text-[#a1a1aa]">模型参数</div>
                      <div className="space-y-4">
                        {cloudProtocol === "openai" && cloudApiFormat === "responses" && (
                          <>
                            <div>
                              <label className="mb-1.5 block text-[12px] text-[#a1a1aa]">Reasoning Effort</label>
                              <p className="mb-2 text-[11px] text-[#71717a]">建议保持 None，响应最快且不容易触发云端 524；只有复杂推理任务再手动切到 High / XHigh。</p>
                              <select
                                value={normalizeOpenAiReasoningEffort(draftCloudConfig.reasoningEffort)}
                                onChange={(e) => updateCloudDraftServer({ reasoningEffort: normalizeOpenAiReasoningEffort(e.target.value) })}
                                className="w-full rounded-md border border-[#27272a] bg-[#000000] p-2.5 text-[14px] text-white outline-none theme-ring"
                              >
                                <option value="none">None</option>
                                <option value="minimal">Minimal</option>
                                <option value="low">Low</option>
                                <option value="medium">Medium</option>
                                <option value="high">High</option>
                                <option value="xhigh">XHigh</option>
                              </select>
                            </div>

                            <label className="flex items-start gap-3 rounded-md border border-[#27272a] bg-[#000000] p-3">
                              <input
                                type="checkbox"
                                checked={draftCloudConfig.disableResponseStorage !== false}
                                onChange={(e) => updateCloudDraftServer({ disableResponseStorage: e.target.checked })}
                                className="mt-0.5"
                              />
                              <span className="min-w-0">
                                <span className="block text-[12px] font-medium text-[#e4e4e7]">Disable Response Storage</span>
                                <span className="mt-1 block text-[11px] text-[#71717a]">对应 Codex `disable_response_storage = true`，会发送 `store: false`</span>
                              </span>
                            </label>

                            <p className="text-[11px] leading-relaxed text-[#71717a]">`Responses + gpt-5.4` 现在会尽量贴近 Codex 请求形态：使用顶层 `instructions`、发送 `store: false` / `reasoning.effort`，并让采样参数走服务端默认值。</p>
                          </>
                        )}

                        <div>
                          <div className="mb-1.5 flex items-center justify-between">
                            <span className="text-[12px] text-[#a1a1aa]">Temperature</span>
                            <span className="rounded border theme-subtle-border px-2 py-0.5 font-mono text-[12px] theme-subtle-bg">{(draftCloudConfig.temperature ?? 0.6).toFixed(2)}</span>
                          </div>
                          <p className="mb-2 text-[11px] text-[#71717a]">控制输出的随机性。值越低越确定，值越高越多样</p>
                          <input type="range" min="0" max="2" step="0.05" value={draftCloudConfig.temperature ?? 0.6} onChange={(e) => updateCloudDraftServer({ temperature: parseFloat(e.target.value) })} className="w-full cursor-pointer theme-slider" />
                          <div className="mt-1 flex justify-between font-mono text-[11px] text-[#3f3f46]">
                            <span>0 (精确)</span><span>1</span><span>2 (创意)</span>
                          </div>
                        </div>

                        <div>
                          <div className="mb-1.5 flex items-center justify-between">
                            <span className="text-[12px] text-[#a1a1aa]">Top P</span>
                            <span className="rounded border theme-subtle-border px-2 py-0.5 font-mono text-[12px] theme-subtle-bg">{(draftCloudConfig.topP ?? 0.95).toFixed(2)}</span>
                          </div>
                          <p className="mb-2 text-[11px] text-[#71717a]">核采样阈值，与 Temperature 共同影响生成质量</p>
                          <input type="range" min="0" max="1" step="0.05" value={draftCloudConfig.topP ?? 0.95} onChange={(e) => updateCloudDraftServer({ topP: parseFloat(e.target.value) })} className="w-full cursor-pointer theme-slider" />
                          <div className="mt-1 flex justify-between font-mono text-[11px] text-[#3f3f46]">
                            <span>0 (窄)</span><span>0.5</span><span>1 (宽)</span>
                          </div>
                        </div>
                      </div>
                    </section>
                      </>
                    ) : (
                      <section className="rounded-lg border border-dashed border-[#27272a] bg-[#000000] p-8 text-center">
                        <div className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-md border border-[#27272a] bg-[#09090b] text-[#71717a]">
                          <IconCloud className="h-4 w-4" />
                        </div>
                        <p className="text-[13px] font-bold text-[#e4e4e7]">从 0 开始添加云端服务器</p>
                        <p className="mt-1 text-[11.5px] text-[#71717a]">当前没有任何云端接口配置。点击新增后填写名称、协议、Endpoint 和 API Key。</p>
                        <button
                          onClick={addCloudServer}
                          className="mt-4 inline-flex items-center justify-center gap-2 rounded-md theme-bg theme-bg-hover px-3 py-2 text-[12px] font-bold text-white transition-colors"
                        >
                          <IconPlus className="h-3.5 w-3.5" /> 新增服务器
                        </button>
                      </section>
                    )}
                  </div>
                </div>

                <div className="p-3 bg-[#000000] border border-[#27272a] rounded-md">
                  <p className="text-[11px] text-[#71717a] leading-relaxed">
                    <span className="text-[#a1a1aa]">提示</span>：推荐优先让用户直接在这里填写协议、Endpoint、API Key、额外请求头与模型名，不额外依赖外部配置文件。点击“刷新”会按当前选中的服务器尝试发现可用模型。
                  </p>
                </div>
              </div>
            )}
          </div>
        </div>
        <div className="shrink-0 px-6 py-4 border-t border-[#27272a] bg-[#000000] flex justify-end gap-3">
          <button onClick={onClose} className="px-5 py-1.5 text-[13px] text-[#a1a1aa] hover:text-white transition-colors">Cancel</button>
          <button onClick={onClose} className="px-6 py-1.5 theme-bg theme-bg-hover text-[13px] font-bold rounded-md transition-colors shadow-sm">Done</button>
        </div>
      </div>
    </div>
  ) : null;
}
