// @ts-nocheck
import React, { useState, useEffect, useRef, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import { IconSettings, IconClose } from "./Icons";
import { type MCPServer, type MCPTool, discoverAllMcpTools, setMcpToolServerMap } from "../lib/mcpClient";
import {
  buildOpenAiResponsesInputCandidates,
  buildOpenAiResponsesRequestExtras,
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
import { exportTextFile } from "../lib/ipc";
import { useAppStore } from "../store/useAppStore";

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
        管理本地存储的数据。所有设置和会话记录保存在浏览器 localStorage 中，页面刷新后自动恢复。
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
              onClick={() => {
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
  const [cloudAvailableModels, setCloudAvailableModels] = useState<string[]>([]);
  const [isFetchingModels, setIsFetchingModels] = useState(false);
  const [isFetchingCloudModels, setIsFetchingCloudModels] = useState(false);
  const [isTestingCloudConnection, setIsTestingCloudConnection] = useState(false);
  const [cloudModelInputMode, setCloudModelInputMode] = useState<"select" | "manual">("manual");
  const [cloudFetchMsg, setCloudFetchMsg] = useState<{ text: string; type: 'success' | 'error' } | null>(null);
  const [cloudProbeMsg, setCloudProbeMsg] = useState<{ text: string; type: 'success' | 'error' } | null>(null);
  const [localFetchMsg, setLocalFetchMsg] = useState<{ text: string; type: 'success' | 'error' } | null>(null);
  const [systemMemory, setSystemMemory] = useState<{ total_gb: number; available_gb: number; total_bytes?: number; available_bytes?: number } | null>(null);
  const hasAutoFetched = useRef(false);
  const hasAutoFetchedCloud = useRef(false);

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

  const cloudProtocol = normalizeCloudProtocol(config.cloud.protocol);
  const cloudApiFormat = normalizeCloudApiFormat(config.cloud.apiFormat);
  const parsedCloudCustomHeaders = parseCloudCustomHeaders(config.cloud.customHeaders || "");
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

  const handleCloudProtocolChange = (e) => {
    const nextProtocol = normalizeCloudProtocol(e.target.value);
    const nextEndpoint = nextProtocol === "anthropic" ? "https://api.anthropic.com" : "https://api.openai.com/v1";

    setConfig((prev) => {
      const previousProtocol = normalizeCloudProtocol(prev.cloud.protocol);
      const previousDefaultEndpoint = previousProtocol === "anthropic" ? "https://api.anthropic.com" : "https://api.openai.com/v1";
      const currentEndpoint = prev.cloud.endpoint || "";
      const shouldReplaceEndpoint = !currentEndpoint.trim() || currentEndpoint === previousDefaultEndpoint;

      return {
        ...prev,
        cloud: {
          ...prev.cloud,
          protocol: nextProtocol,
          apiFormat: nextProtocol === "anthropic" ? "chat_completions" : normalizeCloudApiFormat(prev.cloud.apiFormat),
          provider: nextProtocol === "anthropic" ? "Anthropic" : "OpenAI",
          endpoint: shouldReplaceEndpoint ? nextEndpoint : currentEndpoint,
        },
      };
    });
    setCloudFetchMsg(null);
    setCloudProbeMsg(null);
  };

  const handleCloudApiFormatChange = (e) => {
    const nextApiFormat = normalizeCloudApiFormat(e.target.value);
    setConfig((prev) => ({
      ...prev,
      cloud: {
        ...prev.cloud,
        apiFormat: nextApiFormat,
      },
    }));
    setCloudProbeMsg(null);
  };

  const refreshCloudModels = useCallback(async () => {
    if (isFetchingCloudModels) return;
    setIsFetchingCloudModels(true);
    setCloudFetchMsg(null);

    try {
      const endpoint = config.cloud.endpoint?.trim();
      if (!endpoint) {
        setCloudFetchMsg({ text: "请先填写 API Endpoint", type: "error" });
        return;
      }

      const candidates = buildCloudModelListCandidates(endpoint, cloudProtocol);
      const headers = buildCloudHeaders(cloudProtocol, config.cloud.apiKey || "", false, config.cloud.customHeaders);

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

          const selectedModel = models.includes(config.cloud.model) ? config.cloud.model : models[0];
          setCloudAvailableModels(models);
          setCloudModelInputMode("select");
          setConfig((prev) => ({
            ...prev,
            cloud: { ...prev.cloud, model: selectedModel },
          }));
          setCloudFetchMsg({ text: `已拉取 ${models.length} 个模型，当前选择 ${selectedModel}`, type: "success" });
          return;
        } catch {
          // Try next candidate URL
        }
      }

      setCloudAvailableModels([]);
      setCloudFetchMsg({ text: "未发现可用模型，请检查 Endpoint、协议和 API Key", type: "error" });
    } catch (err) {
      setCloudAvailableModels([]);
      setCloudFetchMsg({ text: "连接失败: " + (err instanceof Error ? err.message : String(err)), type: "error" });
    } finally {
      setIsFetchingCloudModels(false);
    }
  }, [cloudProtocol, config.cloud.apiKey, config.cloud.customHeaders, config.cloud.endpoint, isFetchingCloudModels, setConfig]);

  const testCloudConnection = useCallback(async () => {
    if (isTestingCloudConnection) return;

    const endpoint = config.cloud.endpoint?.trim();
    const testModel = config.cloud.model?.trim() || cloudAvailableModels[0] || "";
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

    try {
      const headers = buildCloudHeaders(cloudProtocol, config.cloud.apiKey || "", true, config.cloud.customHeaders);
      let effectiveApiFormat = cloudApiFormat;
      let payload: unknown = null;

      const sendJsonProbe = async (url: string, body: Record<string, unknown>) => {
        let lastError: Error | null = null;
        console.log("[cloud-test] probe request", JSON.stringify({
          url,
          model: body.model,
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

      if (cloudProtocol === "anthropic") {
        const url = buildCloudMessagesApiUrl(endpoint, cloudProtocol, cloudApiFormat);
        payload = await sendJsonProbe(url, buildAnthropicRequestBody({
          messages: [{ role: "user", content: "你好，请只回复 ok" }],
          model: testModel,
          maxTokens: 32,
          stream: false,
          temperature: config.cloud.temperature ?? 0.2,
          topP: config.cloud.topP ?? 0.95,
        }));
      } else {
        const openAiProbeFormats = [cloudApiFormat, cloudApiFormat === "responses" ? "chat_completions" : "responses"];
        let lastError = null;

        for (const probeFormat of openAiProbeFormats) {
          const url = buildCloudMessagesApiUrl(endpoint, cloudProtocol, probeFormat);
          try {
            if (probeFormat === "responses") {
              const inputCandidates = buildOpenAiResponsesInputCandidates([
                { role: "user", content: "你好，请只回复 ok" },
              ]);
              let lastCandidateError = null;

              for (const candidate of inputCandidates) {
                try {
                  payload = await sendJsonProbe(url, {
                    model: testModel,
                    input: candidate.input,
                    ...buildOpenAiResponsesRequestExtras({
                      disableResponseStorage: config.cloud.disableResponseStorage,
                      reasoningEffort: config.cloud.reasoningEffort,
                    }),
                  });
                  effectiveApiFormat = probeFormat;
                  lastError = null;
                  lastCandidateError = null;
                  break;
                } catch (candidateErr) {
                  lastCandidateError = candidateErr;
                  const errMsg = candidateErr instanceof Error ? candidateErr.message : String(candidateErr);
                  if (!isProviderCompatibilityErrorMessage(errMsg) && !isRetryableCloudErrorMessage(errMsg)) throw candidateErr;
                }
              }

              if (payload != null) break;
              throw lastCandidateError ?? new Error("Responses probe failed without a compatibility fallback result.");
            }

            payload = await sendJsonProbe(url, {
              model: testModel,
              messages: [{ role: "user", content: "你好，请只回复 ok" }],
              stream: false,
              max_tokens: 32,
            });
            effectiveApiFormat = probeFormat;
            lastError = null;
            break;
          } catch (probeErr) {
            lastError = probeErr;
            const errMsg = probeErr instanceof Error ? probeErr.message : String(probeErr);
            if (!isProviderCompatibilityErrorMessage(errMsg) && !isRetryableCloudErrorMessage(errMsg)) throw probeErr;
          }
        }

        if (payload == null) {
          throw lastError ?? new Error("OpenAI probe failed without a compatibility fallback result.");
        }
      }

      if (cloudProtocol === "openai" && effectiveApiFormat !== cloudApiFormat) {
        setConfig((prev) => ({
          ...prev,
          cloud: {
            ...prev.cloud,
            apiFormat: effectiveApiFormat,
          },
        }));
      }

      const reply = cloudProtocol === "anthropic"
        ? extractAnthropicResponseText(payload).trim()
        : extractOpenAiResponseText(payload, effectiveApiFormat).trim();

      setCloudProbeMsg({
        text: reply
          ? `连通成功，${testModel} 返回：${reply.slice(0, 120)}${cloudProtocol === "openai" && effectiveApiFormat !== cloudApiFormat ? `（已自动切换到 ${effectiveApiFormat === "responses" ? "Responses API" : "Chat Completions"}）` : ""}。此测试是短文本非流式请求，真实任务会发送更长上下文。`
          : `连通成功，${testModel} 已返回有效响应${cloudProtocol === "openai" && effectiveApiFormat !== cloudApiFormat ? `，并已自动切换到 ${effectiveApiFormat === "responses" ? "Responses API" : "Chat Completions"}` : ""}。此测试是短文本非流式请求，真实任务会发送更长上下文。`,
        type: "success",
      });
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
    cloudProtocol,
    config.cloud.apiKey,
    config.cloud.customHeaders,
    config.cloud.disableResponseStorage,
    config.cloud.endpoint,
    config.cloud.model,
    config.cloud.reasoningEffort,
    config.cloud.temperature,
    config.cloud.topP,
    isTestingCloudConnection,
  ]);

  useEffect(() => {
    if (isOpen && settingsTab === "cloud" && !hasAutoFetchedCloud.current) {
      hasAutoFetchedCloud.current = true;
      if (config.cloud.endpoint?.trim()) {
        refreshCloudModels();
      }
    }
    if (!isOpen) hasAutoFetchedCloud.current = false;
  }, [config.cloud.endpoint, isOpen, refreshCloudModels, settingsTab]);

  const prevCloudProtocol = useRef(cloudProtocol);
  const prevCloudEndpoint = useRef(config.cloud.endpoint);
  const prevCloudApiKey = useRef(config.cloud.apiKey);
  const prevCloudCustomHeaders = useRef(config.cloud.customHeaders);
  useEffect(() => {
    const protocolChanged = prevCloudProtocol.current !== cloudProtocol;
    const endpointChanged = prevCloudEndpoint.current !== config.cloud.endpoint;
    const apiKeyChanged = prevCloudApiKey.current !== config.cloud.apiKey;
    const customHeadersChanged = prevCloudCustomHeaders.current !== config.cloud.customHeaders;

    if (!protocolChanged && !endpointChanged && !apiKeyChanged && !customHeadersChanged) return;

    prevCloudProtocol.current = cloudProtocol;
    prevCloudEndpoint.current = config.cloud.endpoint;
    prevCloudApiKey.current = config.cloud.apiKey;
    prevCloudCustomHeaders.current = config.cloud.customHeaders;

    if (!config.cloud.endpoint?.trim()) {
      setCloudAvailableModels([]);
      setCloudModelInputMode("manual");
      return;
    }

    if (hasAutoFetchedCloud.current && settingsTab === "cloud") {
      refreshCloudModels();
    }
  }, [cloudProtocol, config.cloud.apiKey, config.cloud.customHeaders, config.cloud.endpoint, refreshCloudModels, settingsTab]);

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
    <div className="absolute inset-0 bg-black/80 flex items-center justify-center z-50 backdrop-blur-sm">
      <div className="bg-[#09090b] border border-[#27272a] rounded-xl shadow-2xl w-[780px] flex flex-col overflow-hidden">
        <div className="px-5 py-4 border-b border-[#27272a] flex items-center justify-between bg-[#000000]">
          <h2 className="text-base font-bold text-white flex items-center gap-2"><IconSettings className="w-5 h-5" /> {t.settings}</h2>
          <button onClick={onClose} className="text-[#a1a1aa] hover:text-white transition-colors"><IconClose className="w-4 h-4" /></button>
        </div>

        <div className="flex h-[560px]">
          <div className="w-40 border-r border-[#27272a] bg-[#000000] p-2 flex flex-col gap-1">
            <button onClick={() => setSettingsTab('general')} className={`text-left px-4 py-2.5 text-[13px] font-medium rounded-md transition-colors ${settingsTab === 'general' ? 'theme-bg shadow-sm' : 'text-[#a1a1aa] hover:text-[#e4e4e7] hover:bg-[#18181b]'}`}>{t.general}</button>
            <button onClick={() => setSettingsTab('local')} className={`text-left px-4 py-2.5 text-[13px] font-medium rounded-md transition-colors ${settingsTab === 'local' ? 'theme-bg shadow-sm' : 'text-[#a1a1aa] hover:text-[#e4e4e7] hover:bg-[#18181b]'}`}>{t.localSetup}</button>
            <button onClick={() => setSettingsTab('cloud')} className={`text-left px-4 py-2.5 text-[13px] font-medium rounded-md transition-colors ${settingsTab === 'cloud' ? 'theme-bg shadow-sm' : 'text-[#a1a1aa] hover:text-[#e4e4e7] hover:bg-[#18181b]'}`}>{t.cloudSetup}</button>
            <button onClick={() => setSettingsTab('context')} className={`text-left px-4 py-2.5 text-[13px] font-medium rounded-md transition-colors ${settingsTab === 'context' ? 'theme-bg shadow-sm' : 'text-[#a1a1aa] hover:text-[#e4e4e7] hover:bg-[#18181b]'}`}>{t.contextSetup}</button>
            <button onClick={() => setSettingsTab('mcp')} className={`text-left px-4 py-2.5 text-[13px] font-medium rounded-md transition-colors ${settingsTab === 'mcp' ? 'theme-bg shadow-sm' : 'text-[#a1a1aa] hover:text-[#e4e4e7] hover:bg-[#18181b]'}`}>MCP 服务器</button>
            <button onClick={() => setSettingsTab('data')} className={`text-left px-4 py-2.5 text-[13px] font-medium rounded-md transition-colors ${settingsTab === 'data' ? 'theme-bg shadow-sm' : 'text-[#a1a1aa] hover:text-[#e4e4e7] hover:bg-[#18181b]'}`}>{t.dataManagement}</button>
            <button onClick={() => setSettingsTab('debug')} className={`text-left px-4 py-2.5 text-[13px] font-medium rounded-md transition-colors ${settingsTab === 'debug' ? 'theme-bg shadow-sm' : 'text-[#a1a1aa] hover:text-[#e4e4e7] hover:bg-[#18181b]'}`}>{t.debugLog}</button>
          </div>
          <div className="flex-1 p-6 overflow-y-auto bg-[#09090b]">

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

            {/* CLOUDED API SETTINGS */}
            {settingsTab === 'cloud' && (
              <div className="space-y-6">
                <div className="flex items-center justify-between">
                  <h3 className="text-[13px] font-bold text-[#a1a1aa] uppercase tracking-wider">{t.cloudSetup}</h3>
                  <button onClick={() => setConfig({ ...config, activeProfile: 'cloud' })} className={`text-[11px] px-2.5 py-1.5 rounded border uppercase font-bold tracking-wider transition-colors ${config.activeProfile === 'cloud' ? 'theme-subtle-bg theme-subtle-border theme-text' : 'bg-[#18181b] text-[#a1a1aa] border-transparent hover:text-white'}`}>
                    {config.activeProfile === 'cloud' ? 'Active Profile' : 'Set as Active'}
                  </button>
                </div>

                <div>
                  <label className="block text-[13px] font-bold text-[#e4e4e7] mb-2">API Protocol</label>
                  <p className="text-[11.5px] text-[#71717a] mb-2">选择云端服务遵循的协议格式。聚合平台通常走 OpenAI Compatible，Claude 原生接口走 Anthropic</p>
                  <select
                    value={cloudProtocol}
                    onChange={handleCloudProtocolChange}
                    className="w-full bg-[#000000] border border-[#27272a] rounded-md p-2.5 text-[14px] text-white focus:outline-none theme-ring"
                  >
                    <option value="openai">OpenAI Compatible</option>
                    <option value="anthropic">Anthropic</option>
                  </select>
                </div>

                {cloudProtocol === "openai" && (
                  <div>
                    <label className="block text-[13px] font-bold text-[#e4e4e7] mb-2">API Format</label>
                    <p className="text-[11.5px] text-[#71717a] mb-2">弱兼容网关可先尝试 Chat Completions；如果服务像 Codex 一样使用 `wire_api = responses`，请切换到 Responses API</p>
                    <select
                      value={cloudApiFormat}
                      onChange={handleCloudApiFormatChange}
                      className="w-full bg-[#000000] border border-[#27272a] rounded-md p-2.5 text-[14px] text-white focus:outline-none theme-ring"
                    >
                      <option value="chat_completions">OpenAI Chat Completions</option>
                      <option value="responses">OpenAI Responses API</option>
                    </select>
                  </div>
                )}

                <div>
                  <label className="block text-[13px] font-bold text-[#e4e4e7] mb-2">API Endpoint</label>
                  <p className="text-[11.5px] text-[#71717a] mb-2">{cloudEndpointHint}</p>
                  <input type="text" value={config.cloud.endpoint || ""} onChange={(e) => setConfig({ ...config, cloud: { ...config.cloud, endpoint: e.target.value } })} placeholder={cloudEndpointPlaceholder} className="w-full bg-[#000000] border border-[#27272a] rounded-md p-2.5 text-[14px] text-white focus:outline-none theme-ring font-mono placeholder:text-[#3f3f46]" />
                </div>

                <div>
                  <label className="block text-[13px] font-bold text-[#e4e4e7] mb-2">API Key <span className="text-[#71717a] font-normal">(如服务不需要可留空)</span></label>
                  <p className="text-[11.5px] text-[#71717a] mb-2">{cloudProtocol === "anthropic" ? "Anthropic 协议会使用 x-api-key 请求头" : "OpenAI 兼容协议会默认同时发送 Authorization: Bearer 和 x-api-key 请求头，以兼容更多聚合网关"}</p>
                  <input type="password" value={config.cloud.apiKey || ""} onChange={(e) => setConfig({ ...config, cloud: { ...config.cloud, apiKey: e.target.value } })} placeholder={cloudApiKeyPlaceholder} className="w-full bg-[#000000] border border-[#27272a] rounded-md p-2.5 text-[14px] text-white focus:outline-none theme-ring font-mono placeholder:text-[#3f3f46]" />
                </div>

                <div>
                  <label className="block text-[13px] font-bold text-[#e4e4e7] mb-2">Additional Headers (JSON) <span className="text-[#71717a] font-normal">(可选)</span></label>
                  <p className="text-[11.5px] text-[#71717a] mb-2">需要厂商专用请求头时可填写 JSON 对象，或 [{'{'}"header","value"{'}'}] 数组，例如 {`{"HTTP-Referer":"https://example.com","X-Title":"MAIN"}`}</p>
                  <textarea
                    value={config.cloud.customHeaders || ""}
                    onChange={(e) => setConfig({ ...config, cloud: { ...config.cloud, customHeaders: e.target.value } })}
                    placeholder='{"HTTP-Referer":"https://example.com","X-Title":"MAIN"}'
                    className="w-full min-h-[92px] bg-[#000000] border border-[#27272a] rounded-md p-2.5 text-[13px] text-white focus:outline-none theme-ring font-mono placeholder:text-[#3f3f46] resize-y"
                  />
                  {parsedCloudCustomHeaders.error ? (
                    <p className="mt-2 text-[12px] text-[#f48771]">{parsedCloudCustomHeaders.error}</p>
                  ) : (
                    <p className="mt-2 text-[11px] text-[#71717a]">
                      当前将附加 {Object.keys(parsedCloudCustomHeaders.headers).length} 个自定义请求头
                    </p>
                  )}
                </div>

                <div>
                  <label className="block text-[13px] font-bold text-[#e4e4e7] mb-2">Model Name</label>
                  <div className="flex items-center justify-between gap-3 mb-2">
                    <p className="text-[11.5px] text-[#71717a]">远端服务上的模型标识，刷新成功后可直接下拉选择</p>
                    {cloudAvailableModels.length > 0 && (
                      <button
                        data-testid="cloud-model-mode-toggle"
                        onClick={() => {
                          if (cloudModelInputMode === "manual") {
                            const nextModel = cloudAvailableModels.includes(config.cloud.model)
                              ? config.cloud.model
                              : cloudAvailableModels[0];
                            setConfig({ ...config, cloud: { ...config.cloud, model: nextModel } });
                            setCloudModelInputMode("select");
                            return;
                          }
                          setCloudModelInputMode("manual");
                        }}
                        className="text-[11px] font-bold text-[#a1a1aa] hover:text-white transition-colors shrink-0"
                      >
                        {cloudModelInputMode === "select" ? "手动输入" : "下拉选择"}
                      </button>
                    )}
                  </div>
                  <div className="flex gap-2">
                    {cloudAvailableModels.length > 0 && cloudModelInputMode === "select" ? (
                      <select
                        data-testid="cloud-model-select"
                        value={config.cloud.model || ""}
                        onChange={(e) => setConfig({ ...config, cloud: { ...config.cloud, model: e.target.value } })}
                        disabled={isFetchingCloudModels}
                        className="flex-1 bg-[#000000] border border-[#27272a] rounded-md p-2.5 text-[14px] text-white focus:outline-none theme-ring transition-colors cursor-pointer"
                      >
                        {cloudAvailableModels.map((model) => (
                          <option key={model} value={model}>{model}</option>
                        ))}
                      </select>
                    ) : (
                      <input data-testid="cloud-model-input" type="text" value={config.cloud.model || ""} onChange={(e) => setConfig({ ...config, cloud: { ...config.cloud, model: e.target.value } })} placeholder={cloudModelPlaceholder} className="flex-1 bg-[#000000] border border-[#27272a] rounded-md p-2.5 text-[14px] text-white focus:outline-none theme-ring font-mono placeholder:text-[#3f3f46]" />
                    )}
                    <button
                      data-testid="cloud-model-refresh"
                      onClick={refreshCloudModels}
                      disabled={isFetchingCloudModels}
                      className="px-3 py-2 text-[12px] font-bold bg-[#18181b] text-[#a1a1aa] hover:text-white border border-[#27272a] rounded-md transition-colors shrink-0 disabled:opacity-50"
                    >{isFetchingCloudModels ? '刷新中...' : '刷新'}</button>
                    <button
                      data-testid="cloud-model-test"
                      onClick={testCloudConnection}
                      disabled={isTestingCloudConnection}
                      className="px-3 py-2 text-[12px] font-bold bg-[#18181b] text-[#a1a1aa] hover:text-white border border-[#27272a] rounded-md transition-colors shrink-0 disabled:opacity-50"
                    >{isTestingCloudConnection ? '测试中...' : '测试'}</button>
                  </div>
                  {cloudAvailableModels.length > 0 && (
                    <p data-testid="cloud-model-fetched-count" className="mt-2 text-[11px] text-[#71717a]">
                      已拉取 {cloudAvailableModels.length} 个模型
                    </p>
                  )}
                  {cloudFetchMsg && (
                    <p className={`mt-2 text-[12px] ${cloudFetchMsg.type === 'error' ? 'text-[#f48771]' : 'text-[#86d9a3]'}`}>
                      {cloudFetchMsg.text}
                    </p>
                  )}
                  {cloudProbeMsg && (
                    <p className={`mt-2 text-[12px] ${cloudProbeMsg.type === 'error' ? 'text-[#f48771]' : 'text-[#86d9a3]'}`}>
                      {cloudProbeMsg.text}
                    </p>
                  )}
                </div>

                <div className="pt-5 border-t border-[#27272a]">
                  <label className="block text-xs font-bold text-[#e4e4e7] mb-3">模型参数</label>

                  <div className="space-y-4">
                    {cloudProtocol === "openai" && cloudApiFormat === "responses" && (
                      <>
                        <div>
                          <label className="block text-[12px] text-[#a1a1aa] mb-1.5">Reasoning Effort</label>
                          <p className="text-[11px] text-[#71717a] mb-2">建议保持 None，响应最快且不容易触发云端 524；只有复杂推理任务再手动切到 High / XHigh。</p>
                          <select
                            value={normalizeOpenAiReasoningEffort(config.cloud.reasoningEffort)}
                            onChange={(e) => setConfig({ ...config, cloud: { ...config.cloud, reasoningEffort: normalizeOpenAiReasoningEffort(e.target.value) } })}
                            className="w-full bg-[#000000] border border-[#27272a] rounded-md p-2.5 text-[14px] text-white focus:outline-none theme-ring"
                          >
                            <option value="none">None</option>
                            <option value="minimal">Minimal</option>
                            <option value="low">Low</option>
                            <option value="medium">Medium</option>
                            <option value="high">High</option>
                            <option value="xhigh">XHigh</option>
                          </select>
                        </div>

                        <label className="flex items-start gap-3 p-3 bg-[#000000] border border-[#27272a] rounded-md">
                          <input
                            type="checkbox"
                            checked={config.cloud.disableResponseStorage !== false}
                            onChange={(e) => setConfig({ ...config, cloud: { ...config.cloud, disableResponseStorage: e.target.checked } })}
                            className="mt-0.5"
                          />
                          <span className="min-w-0">
                            <span className="block text-[12px] text-[#e4e4e7] font-medium">Disable Response Storage</span>
                            <span className="block text-[11px] text-[#71717a] mt-1">对应 Codex `disable_response_storage = true`，会发送 `store: false`</span>
                          </span>
                        </label>

                        <p className="text-[11px] text-[#71717a] leading-relaxed">
                          `Responses + gpt-5.4` 现在会尽量贴近 Codex 请求形态：使用顶层 `instructions`、发送 `store: false` / `reasoning.effort`，并让采样参数走服务端默认值。
                        </p>
                      </>
                    )}

                    <div>
                      <div className="flex justify-between items-center mb-1.5">
                        <span className="text-[12px] text-[#a1a1aa]">Temperature</span>
                        <span className="text-[12px] font-mono theme-subtle-bg px-2 py-0.5 rounded border theme-subtle-border">{(config.cloud.temperature ?? 0.6).toFixed(2)}</span>
                      </div>
                      <p className="text-[11px] text-[#71717a] mb-2">控制输出的随机性。值越低越确定，值越高越多样</p>
                      <input type="range" min="0" max="2" step="0.05" value={config.cloud.temperature ?? 0.6} onChange={(e) => setConfig({ ...config, cloud: { ...config.cloud, temperature: parseFloat(e.target.value) } })} className="w-full theme-slider cursor-pointer" />
                      <div className="flex justify-between text-[11px] text-[#3f3f46] font-mono mt-1">
                        <span>0 (精确)</span><span>1</span><span>2 (创意)</span>
                      </div>
                    </div>

                    <div>
                      <div className="flex justify-between items-center mb-1.5">
                        <span className="text-[12px] text-[#a1a1aa]">Top P</span>
                        <span className="text-[12px] font-mono theme-subtle-bg px-2 py-0.5 rounded border theme-subtle-border">{(config.cloud.topP ?? 0.95).toFixed(2)}</span>
                      </div>
                      <p className="text-[11px] text-[#71717a] mb-2">核采样阈值，与 Temperature 共同影响生成质量</p>
                      <input type="range" min="0" max="1" step="0.05" value={config.cloud.topP ?? 0.95} onChange={(e) => setConfig({ ...config, cloud: { ...config.cloud, topP: parseFloat(e.target.value) } })} className="w-full theme-slider cursor-pointer" />
                      <div className="flex justify-between text-[11px] text-[#3f3f46] font-mono mt-1">
                        <span>0 (窄)</span><span>0.5</span><span>1 (宽)</span>
                      </div>
                    </div>
                  </div>
                </div>

                <div className="p-3 bg-[#000000] border border-[#27272a] rounded-md">
                  <p className="text-[11px] text-[#71717a] leading-relaxed">
                    💡 <span className="text-[#a1a1aa]">提示</span>：推荐优先让用户直接在这里填写协议、Endpoint、API Key、额外请求头与模型名，不额外依赖外部配置文件。点击“刷新”会按当前协议尝试发现可用模型。
                  </p>
                </div>
              </div>
            )}
          </div>
        </div>
        <div className="px-6 py-4 border-t border-[#27272a] bg-[#000000] flex justify-end gap-3">
          <button onClick={onClose} className="px-5 py-1.5 text-[13px] text-[#a1a1aa] hover:text-white transition-colors">Cancel</button>
          <button onClick={onClose} className="px-6 py-1.5 theme-bg theme-bg-hover text-[13px] font-bold rounded-md transition-colors shadow-sm">Done</button>
        </div>
      </div>
    </div>
  ) : null;
}
