// @ts-nocheck
import React, { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { save } from "@tauri-apps/plugin-dialog";
import { IconSettings, IconClose, IconPlus, IconTrash, IconCloud, IconSave, IconCheck, IconGitHub, IconChevronDown, IconChevronUp } from "./Icons";
import {
  type MCPDiagnosticCategory,
  type MCPServer,
  type MCPServerTestResult,
  type MCPTool,
  discoverAllMcpTools,
  setMcpToolServerMap,
  testMcpServer,
} from "../lib/mcpClient";
import {
  buildOpenAiResponsesProbeRequestCandidates,
  buildAnthropicRequestBody,
  buildCloudHeaders,
  buildCloudMessagesApiUrl,
  buildCloudModelListCandidates,
  ensureOpenAiChatGptCodexRequestBody,
  buildGeminiRequestForAuthMode,
  extractAnthropicResponseText,
  extractCloudModelIds,
  extractGeminiResponseText,
  extractOpenAiResponseText,
  parseOpenAiResponsesSseText,
  GEMINI_EXPERIMENTAL_MODELS,
  parseCloudCustomHeaders,
  normalizeCloudApiFormat,
  normalizeCloudAuthMode,
  normalizeCloudProtocol,
  normalizeCloudToolProtocol,
  resolveEffectiveCloudApiFormat,
  getDefaultLocalToolProtocol,
  normalizeLocalToolProtocol,
  normalizeOpenAiReasoningEffort,
  OPENAI_CHATGPT_CODEX_ENDPOINT,
  OPENAI_CHATGPT_EXPERIMENTAL_MODELS,
} from "../lib/cloudProtocol";
import { buildCloudAuthFriendlyError } from "../lib/cloudAuthErrorHints";
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
  createDefaultCloudAuth,
  normalizeCloudAuth,
  normalizeCloudServerState,
} from "../lib/cloudServers";
import { APP_ICON_ASSETS, applyAppIconVariant, normalizeAppIconVariant, type AppIconVariant } from "../lib/appIcon";

function buildCloudConnectionFingerprint(server: any, apiFormatOverride?: unknown, modelOverride?: unknown): string {
  if (!server) return "";
  const auth = server.auth || {};
  return JSON.stringify({
    endpoint: String(server.endpoint || "").trim(),
    protocol: normalizeCloudProtocol(server.protocol),
    apiFormat: normalizeCloudApiFormat(apiFormatOverride ?? server.apiFormat),
    authMode: normalizeCloudAuthMode(auth.mode),
    tokenRef: String(auth.tokenRef || ""),
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
    && normalizeCloudAuthMode(current.auth?.mode) === normalizeCloudAuthMode(target.auth?.mode)
    && String(current.auth?.tokenRef || "") === String(target.auth?.tokenRef || "")
    && String(current.apiKey || "") === String(target.apiKey || "")
    && String(current.customHeaders || "") === String(target.customHeaders || "");
}

const settingsSectionRowClass = "grid gap-3 lg:grid-cols-[minmax(190px,300px)_minmax(0,1fr)] lg:items-start lg:gap-8";
const settingsControlColumnClass = "w-full lg:ml-auto lg:max-w-[620px]";
const settingsOptionBaseClass = "border bg-[#000000] text-[#a1a1aa] transition-all duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[#09090b]";
const settingsOptionSelectedClass = "theme-text theme-subtle-border bg-transparent ring-1 ring-inset ring-[var(--accent-light)] hover:bg-[var(--accent-subtle)]";

const DEFAULT_CLOUD_ENDPOINTS = {
  openai: "https://api.openai.com/v1",
  anthropic: "https://api.anthropic.com",
  gemini: "https://generativelanguage.googleapis.com",
} as const;

function defaultCloudEndpointForProtocol(protocol: "openai" | "anthropic" | "gemini"): string {
  return DEFAULT_CLOUD_ENDPOINTS[protocol] || DEFAULT_CLOUD_ENDPOINTS.openai;
}

function shouldReplaceCloudEndpointForProtocol(currentEndpoint: string | undefined, nextProtocol: "openai" | "anthropic" | "gemini"): boolean {
  const current = String(currentEndpoint || "").trim().replace(/\/+$/, "");
  if (!current) return true;
  const defaults = Object.values(DEFAULT_CLOUD_ENDPOINTS).map((endpoint) => endpoint.replace(/\/+$/, ""));
  if (defaults.includes(current)) return true;
  let hostname = "";
  try {
    hostname = new URL(current).hostname;
  } catch {
    return false;
  }
  if (nextProtocol === "gemini") return /(^|\.)openai\.com$/i.test(hostname) || /(^|\.)anthropic\.com$/i.test(hostname);
  if (nextProtocol === "openai") return /generativelanguage\.googleapis\.com$/i.test(hostname) || /(^|\.)anthropic\.com$/i.test(hostname);
  if (nextProtocol === "anthropic") return /(^|\.)openai\.com$/i.test(hostname) || /generativelanguage\.googleapis\.com$/i.test(hostname);
  return false;
}

function resolveCloudRuntimeEndpoint(server: any, protocol: "openai" | "anthropic" | "gemini", authMode: string): string {
  const endpoint = String(server?.endpoint || "").trim();
  if (authMode === "gemini_google_oauth") return "";
  if (authMode === "openai_chatgpt_oauth") return defaultCloudEndpointForProtocol("openai");
  if (shouldReplaceCloudEndpointForProtocol(endpoint, protocol)) return defaultCloudEndpointForProtocol(protocol);
  return endpoint;
}
const settingsOptionIdleClass = "border-[#27272a] hover:border-[#3f3f46] hover:bg-[#18181b] hover:text-white";
const settingsSelectClass = "w-full rounded-md border border-[#27272a] bg-[#000000] p-2.5 text-[14px] text-white outline-none theme-ring transition-all cursor-pointer focus:border-[var(--accent)] focus:ring-1 focus:ring-inset focus:ring-[var(--accent-light)] disabled:cursor-not-allowed disabled:opacity-60";

function settingsOptionButtonClass(isSelected: boolean, extra = "") {
  return `${settingsOptionBaseClass} ${isSelected ? settingsOptionSelectedClass : settingsOptionIdleClass} ${extra}`.trim();
}

type SettingsUpdateStatus = "idle" | "checking" | "upToDate" | "available" | "downloading" | "installing" | "error";

const MAIN_RELEASES_URL = "https://github.com/MSTUDIOHUB/MAIN-Releases/releases";

function summarizeReleaseNotes(notes: string, maxLength = 520) {
  const normalized = String(notes || "").replace(/\r/g, "").trim();
  if (!normalized) return "";
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength).trimEnd()}…`;
}

const SETTINGS_COPY = {
  zh: {
    activeProfile: "当前配置",
    setAsActive: "设为当前",
    cancel: "取消",
    done: "完成",
    confirmClear: "确认清空",
    confirmReset: "确认重置",
    tipLabel: "提示",
    refresh: "刷新",
    scan: "扫描",
    save: "保存",
    testing: "测试中...",
    test: "测试",
    displayLanguage: "显示语言",
    responseLanguagePolicy: "回复语言策略",
    responseLanguagePolicyDesc: "控制模型回复是跟随输入语言，还是优先使用系统显示语言（可被显式语言指令临时覆盖）。",
    responseLanguageFollowInput: "跟随输入语言（兼容旧行为）",
    responseLanguageSystemPreferred: "系统语言优先（显式指令可切换）",
    enabled: "已启用",
    disabled: "已关闭",
    mcpServerTitle: "MCP 服务器",
    mcpScanTools: "扫描工具",
    mcpScanning: "扫描中...",
    mcpDescription: "配置 MCP (Model Context Protocol) 服务器，使 AI 能够操控外部引擎（如 Unity）。支持 HTTP 传输协议。",
    mcpNoServersConfigured: "暂无 MCP 服务器配置",
    mcpNoServersHint: "点击下方「添加服务器」连接外部引擎",
    remove: "移除",
    mcpEnabled: "已启用",
    mcpDisabled: "已关闭",
    addServer: "添加服务器",
    serverNamePlaceholder: "名称 (如 unityMCP)",
    add: "添加",
    discoveredTools: "已发现的工具",
    mcpDiscovered: (toolCount: number, serverCount: number) => `已发现 ${toolCount} 个工具（来自 ${serverCount} 个服务器）`,
    mcpNoServers: "尚未配置 MCP 服务器",
    mcpNoTools: "未发现任何工具，请检查服务器是否在线",
    mcpDiscoveryFailed: (message: string) => `发现失败: ${message}`,
    mcpTip: "MCP 服务器需先启动并监听指定端口，然后点击「扫描工具」发现可用工具。发现后的工具会在对话中自动供 AI 调用。Unity MCP 服务器默认地址为",
    mcpTestingStatus: "正在测试连接...",
    mcpTestSuccess: (count: number) => `连接成功，发现 ${count} 个工具`,
    mcpTestEmptyTools: "连接成功，但未返回任何工具。请确认 Unity 会话已连接并暴露工具。",
    mcpTestUnreachable: "无法连接服务器。请确认服务已启动并监听该地址。",
    mcpTestRouteMismatch: "地址路由不匹配。请检查 URL 是否应包含 /mcp。",
    mcpTestHeaderMismatch: "请求头不兼容。该服务器要求 Accept: application/json, text/event-stream。",
    mcpTestRpcError: (message: string) => `MCP 返回错误：${message}`,
    mcpTestHttpError: (status: number) => `服务器返回 HTTP ${status} 错误。`,
    mcpTestInvalidResponse: "服务器返回了不可解析的响应，请检查 MCP 实现或代理配置。",
    mcpTestFailed: (message: string) => `测试失败: ${message}`,

    dataPanelDesc: "管理本地数据。设置与会话索引保存在 localStorage，完整会话记录保存在 MAIN 应用数据目录，不写入项目的 .MAIN 目录。",
    dataTip: "所有数据保存在浏览器本地存储中。重置设置不会删除已解压到 .protocols/ 目录的协议包文件，如需彻底清理请手动删除该目录。",

    debugDesc: "记录前端 console、界面崩溃、Rust 代理请求和流式读取错误。日志会自动隐藏常见密钥字段。",
    debugRecordFullTurnProcess: "记录完整回合过程",
    debugRecordFullTurnProcessDesc: "开启后保留完整工具/过程流水（用于排错）；关闭时回合完成后仅保留结论、改动摘要和异常详情。",
    debugFile: "日志文件",
    noDebugLog: "暂无调试日志",
    copiedDebugLog: "已复制调试日志",
    exportedDebugLog: "调试日志已导出",
    clearedDebugLog: "调试日志已清空",
    copyLog: "复制日志",
    exportLog: "导出日志",
    clearLog: "清空日志",
    logTailOnly: "当前只显示日志尾部",

    aboutDesc: "查看 MAIN 版本并手动检查 GitHub Release 更新。",
    appName: "应用名称",
    appIconStyle: "软件图标",
    appIconLight: "白底黑 M",
    appIconDark: "黑底白 M",
    appIconApplyFailed: "软件图标偏好已保存，但当前系统图标未能立即更新，重启应用后会再次应用。",
    unknownVersion: "未知",
    latestCheck: "上次检查",
    neverChecked: "尚未检查",
    noUpdateChecked: "点击检查更新，MAIN 会连接公开 Release 清单并验证签名更新包。",
    updateReadyDesc: (version: string) => `发现 MAIN ${version}，可以安装并重启。`,
    updateUpToDateDesc: "当前已是最新公开版本。",
    updateInstallingDesc: "更新安装完成后，MAIN 会自动重启。",
    updateErrorDesc: "检查或安装失败。你可以稍后重试，或查看调试日志中的 main.update。",
    openGitHubReleases: "打开 GitHub Releases",
    openGitHubReleasesDesc: "在浏览器中查看公开下载页面。",
    openGitHubReleasesFailed: "无法打开 GitHub Releases 页面。",

    compressionLow: "省显存",
    compressionBalanced: "均衡",
    compressionLong: "长上下文",
    compressionLowHint: "更早压缩，适合显存紧张",
    compressionBalancedHint: "上下文与显存占用折中",
    compressionLongHint: "更晚压缩，保留更多历史",
    zoneLow: "省显存 / 更早压缩",
    zoneBalanced: "均衡",
    zoneLong: "长上下文 / 更晚压缩",
    contextTriggerThreshold: "压缩触发阈值 (Token)",
    estimatedContextVram: "预估上下文显存",
    currentLimit: (tokens: string) => `当前上限约 ${tokens} Token`,
    deviceMemory: "设备内存",
    available: "可用",
    maxBar: (value: string, hasSafety: boolean) => `满格约 ${value}${hasSafety ? "，已按当前可用内存预留安全余量" : ""}`,
    contextTip: "此设置用于本地模型的背景压缩与上下文窗口。满格会参考当前可用内存动态计算，并预留约 1GB / 10% 安全余量。",

    providerEngine: "Provider Engine",
    apiEndpoint: "API Endpoint",
    apiKeyOptionalOmlx: "API Key",
    optionalOmlxAuth: "可选，OMLX 服务鉴权用",
    noAuthPlaceholder: "留空则不发送鉴权头",
    localModel: "Local Model",
    localModelUnselected: "未选择模型",
    scanningModels: "正在扫描模型...",
    noModels: "未发现模型 — 请先启动本地推理服务",
    scanModels: "扫描",
    discoveredModels: (count: number) => `已发现 ${count} 个模型`,
    localFetchError: "无法获取模型列表，请检查服务地址和网络连接",

    cloudDesc: "管理多个云端服务器配置。新建或编辑后点击保存，模型列表只会在点击刷新时获取。",
    cloudLab: "实验室",
    cloudLabDesc: "默认仅显示 API Key 配置。开启后显示 OpenAI / Gemini 账号登录等实验入口。",
    cloudLabOn: "实验入口已开启",
    cloudLabOff: "仅 API Key",
    modelName: "Model Name",
    currentServer: "当前服务器：",
    unnamedServer: "未命名服务器",
    unsaved: "未保存",
    manualInput: "手动输入",
    dropdownSelect: "下拉选择",
    refreshing: "刷新中...",
    fetchedModels: (count: number) => `已拉取 ${count} 个模型`,
    noCloudServerTitle: "还没有云端服务器",
    noCloudServerDesc: "从左侧新增服务器后，再在这里手动刷新模型列表。",
    servers: "服务器",
    configs: (count: number) => `${count} 个配置`,
    addServerTitle: "新增服务器",
    serverSearchPlaceholder: "搜索名称、Endpoint、模型",
    noServerConfigs: "暂无服务器配置",
    noMatchingServers: "没有匹配的服务器",
    unsavedServer: "未保存服务器",
    noEndpoint: "未填写 Endpoint",
    serverConfig: "服务器配置",
    unsavedChanges: "有未保存更改",
    savedConfig: "当前服务器配置已保存",
    cloudServerName: "Server Name",
    cloudServerNamePlaceholder: "例如 OpenAI / OpenRouter / 公司网关",
    apiProtocol: "API Protocol",
    apiProtocolDesc: "选择云端服务遵循的协议格式。聚合平台通常走 OpenAI Compatible，Claude 原生接口走 Anthropic。",
    apiFormat: "API Format",
    apiFormatDesc: "弱兼容网关可先尝试 Chat Completions；如果服务像 Codex 一样使用 `wire_api = responses`，请切换到 Responses API。",
    apiFormatLockedByOpenAiOAuth: "OpenAI 实验登录固定使用 Responses API。",
    responsesEndpointPlaceholder: "https://api.openai.com/v1 或完整 /v1/responses 地址",
    chatEndpointPlaceholder: "https://api.openai.com/v1 或完整 /v1/chat/completions 地址",
    anthropicEndpointHint: "Anthropic 协议通常填写根地址，例如 https://api.anthropic.com",
    geminiCodeAssistEndpointHint: "Gemini 登录会走 Google Code Assist 兼容通道，Endpoint 自动固定为 cloudcode-pa.googleapis.com；API Key 模式才使用 Gemini API Endpoint。",
    responsesEndpointHint: "Responses API 可填写 API 根地址（如 https://api.openai.com/v1），也支持直接粘贴完整的 /responses 请求地址。",
    chatEndpointHint: "OpenAI Chat Completions 通常填写 API 根地址（常见以 /v1 结尾），也支持直接粘贴完整的 /chat/completions 地址。",
    apiKeyOptional: "如服务不需要可留空",
    apiKeyDescAnthropic: "Anthropic 协议会使用 x-api-key 请求头。",
    apiKeyDescOpenAi: "OpenAI 兼容协议会默认同时发送 Authorization: Bearer 和 x-api-key 请求头，以兼容更多聚合网关。",
    apiKeyDescGemini: "Gemini API Key 会使用 x-goog-api-key 请求头。",
    authMethod: "认证方式",
    authMethodDesc: "API Key 是稳定主线。",
    authMethodDescLab: "API Key 是稳定主线；账号登录是实验入口，只保存 token 引用，真实 token 留在后端安全存储。",
    authApiKey: "API Key",
    authOpenAiLogin: "OpenAI 登录",
    authGeminiLogin: "Gemini 登录",
    openAiExperimentalLoginTitle: "ChatGPT Pro/Plus/Codex 实验登录",
    openAiExperimentalLoginDesc: "使用系统浏览器完成 OpenAI OAuth，本地回调后改走 ChatGPT/Codex 兼容端点。不承诺免费账号可用。",
    geminiExperimentalLoginTitle: "Gemini Google 实验登录",
    geminiExperimentalLoginDesc: "使用 Google 账号 OAuth，走 Gemini Code Assist 兼容通道，不复用 gemini.google.com 网页会话，也不直接调用 Gemini API Key 端点。",
    geminiCloudProjectHint: "部分 Workspace、企业或 Code Assist 场景可能需要配置 GOOGLE_CLOUD_PROJECT。",
    login: "登录",
    loggingIn: "登录中...",
    logout: "退出登录",
    authConnected: "已登录",
    authPending: "等待浏览器授权...",
    authDisconnected: "未登录",
    authExpired: "登录已过期",
    authStorageFile: "token 已保存到本机 app data 文件（0600 权限），不是系统钥匙串。",
    authStorageKeychain: "token 已保存到系统钥匙串。",
    authStartFailed: (message: string) => `登录启动失败: ${message}`,
    authFinishFailed: (message: string) => `登录完成失败: ${message}`,
    authLogoutFailed: (message: string) => `退出登录失败: ${message}`,
    authBrowserFallback: "浏览器未能自动打开，请手动打开授权链接。",
    authManualOpen: "打开授权链接",
    additionalHeaders: "Additional Headers (JSON)",
    optional: "可选",
    additionalHeadersDesc: "需要厂商专用请求头时可填写 JSON 对象，或 {\"header\",\"value\"} 数组。",
    customHeadersCount: (count: number) => `当前将附加 ${count} 个自定义请求头`,
    advancedCompatibility: "详细设置",
    advancedCompatibilityDesc: "请求头、API format、工具协议、响应存储和推理强度等兼容项。",
    reasoningEffort: "Reasoning Effort",
    reasoningEffortDesc: "建议保持 None，响应最快且不容易触发云端 524；只有复杂推理任务再手动切到 High / XHigh。",
    disableResponseStorage: "Disable Response Storage",
    disableResponseStorageDesc: "对应 Codex `disable_response_storage = true`，会发送 `store: false`。",
    toolProtocol: "Tool Protocol",
    toolProtocolDesc: "Auto 会先尝试原生 tools，遇到不兼容网关会回退 XML；Native 强制原生；XML 直接使用文本工具协议。",
    localToolProtocolOllamaHint: "Ollama 会继续走 /api/chat 文本工具模式，不会发送 OpenAI native tools 参数。",
    responsesCodexDesc: "`Responses + gpt-5.4` 现在会尽量贴近 Codex 请求形态：使用顶层 `instructions`、发送 `store: false` / `reasoning.effort`，并让采样参数走服务端默认值。",
    cloudStartTitle: "从 0 开始添加云端服务器",
    cloudStartDesc: "当前没有任何云端接口配置。点击新增后填写名称、协议、Endpoint 和 API Key。",
    cloudSaveRequired: "请先填写 Server Name 和 API Endpoint",
    cloudSaved: "已保存服务器配置",
    cloudSelectServerFirst: "请先新建或选择一个服务器",
    cloudEndpointRequired: "请先填写 API Endpoint",
    cloudModelsPulled: (count: number, model: string) => `已拉取 ${count} 个模型，当前选择 ${model}`,
    cloudOpenAiProbeFallbackWarning: (model: string) => `模型列表已刷新，但登录探测未找到稳定可用模型。已保留当前选择 ${model}，建议点击“测试”或重新登录。`,
    cloudNoModels: "未发现可用模型，请检查 Endpoint、协议和 API Key",
    cloudConnectionFailed: (message: string) => `连接失败: ${message}`,
    cloudModelRequired: "请先选择或填写一个模型名称",
    cloudAutoSwitch: (format: string) => `，已自动切换到 ${format}`,
    cloudConnected: (model: string, switched: string) => `已连通 ${model}${switched}`,
    cloudBasicSuccessWithReply: (model: string, reply: string, switched: string) => `基础连通成功，${model} 返回：${reply}${switched}。`,
    cloudBasicSuccess: (model: string, switched: string) => `基础连通成功，${model} 已返回有效响应${switched}。`,
    cloudAdvancedSuccess: "高级参数也已通过：store/reasoning 与当前配置兼容。",
    cloudAdvancedWarning: (message: string) => `基础连接可用，但 store/reasoning 高级参数未通过：${message}。真实任务仍会按当前配置发送；如频繁波动，可把 Reasoning Effort 调低或设为 None。`,
    cloudProtocolHint: " 当前这个云端服务看起来不支持 Anthropic /v1/messages，请切换到 OpenAI Compatible 再试。",
    cloudRetryHint: " 这通常是云端网关到上游模型的临时波动，应用已经自动重试过；稍后再试一次通常会恢复。",
    cloudTestFailed: (message: string, protocolHint: string, retryHint: string) => `测试失败: ${message}${protocolHint}${retryHint}`,
  },
  en: {
    activeProfile: "Active Profile",
    setAsActive: "Set as Active",
    cancel: "Cancel",
    done: "Done",
    confirmClear: "Confirm Clear",
    confirmReset: "Confirm Reset",
    tipLabel: "Tip",
    refresh: "Refresh",
    scan: "Scan",
    save: "Save",
    testing: "Testing...",
    test: "Test",
    displayLanguage: "Display Language",
    responseLanguagePolicy: "Response Language Policy",
    responseLanguagePolicyDesc: "Choose whether replies follow each input language or prefer the system language unless the user explicitly requests another language.",
    responseLanguageFollowInput: "Follow Input Language (Legacy)",
    responseLanguageSystemPreferred: "Prefer System Language (Explicit Override)",
    enabled: "Enabled",
    disabled: "Disabled",
    mcpServerTitle: "MCP Servers",
    mcpScanTools: "Scan Tools",
    mcpScanning: "Scanning...",
    mcpDescription: "Configure MCP (Model Context Protocol) servers so the AI can control external engines such as Unity. HTTP transport is supported.",
    mcpNoServersConfigured: "No MCP servers configured",
    mcpNoServersHint: "Use Add Server below to connect an external engine",
    remove: "Remove",
    mcpEnabled: "Enabled",
    mcpDisabled: "Disabled",
    addServer: "Add Server",
    serverNamePlaceholder: "Name (for example unityMCP)",
    add: "Add",
    discoveredTools: "Discovered Tools",
    mcpDiscovered: (toolCount: number, serverCount: number) => `Discovered ${toolCount} tool(s) from ${serverCount} server(s)`,
    mcpNoServers: "No MCP servers configured",
    mcpNoTools: "No tools found. Check whether the servers are online.",
    mcpDiscoveryFailed: (message: string) => `Discovery failed: ${message}`,
    mcpTip: "Start the MCP server and make sure it is listening on the configured port, then click Scan Tools. Discovered tools become available to the AI automatically. Unity MCP defaults to",
    mcpTestingStatus: "Testing connection...",
    mcpTestSuccess: (count: number) => `Connected. Found ${count} tool(s).`,
    mcpTestEmptyTools: "Connected, but no tools were returned. Check Unity session exposure.",
    mcpTestUnreachable: "Cannot reach this server. Make sure it is running and listening on this URL.",
    mcpTestRouteMismatch: "Route mismatch. Check whether the URL should include /mcp.",
    mcpTestHeaderMismatch: "Header mismatch. This server expects Accept: application/json, text/event-stream.",
    mcpTestRpcError: (message: string) => `MCP returned an error: ${message}`,
    mcpTestHttpError: (status: number) => `Server returned HTTP ${status}.`,
    mcpTestInvalidResponse: "Server returned an unparsable response. Check MCP implementation or proxy behavior.",
    mcpTestFailed: (message: string) => `Test failed: ${message}`,

    dataPanelDesc: "Manage local data. Settings and session indexes are stored in localStorage; full conversations are stored in MAIN app data and are not written into the project's .MAIN folder.",
    dataTip: "All data is stored locally in the browser. Resetting settings will not delete protocol packages extracted into .protocols/. Delete that folder manually for a full cleanup.",

    debugDesc: "Records frontend console output, UI crashes, Rust agent requests, and streaming errors. Common secret fields are redacted automatically.",
    debugRecordFullTurnProcess: "Record Full Turn Process",
    debugRecordFullTurnProcessDesc: "When enabled, keep the full tool/process trace for debugging. When disabled, finished turns keep only conclusions, change summaries, and failure details.",
    debugFile: "Log File",
    noDebugLog: "No debug logs yet",
    copiedDebugLog: "Debug log copied",
    exportedDebugLog: "Debug log exported",
    clearedDebugLog: "Debug log cleared",
    copyLog: "Copy Log",
    exportLog: "Export Log",
    clearLog: "Clear Log",
    logTailOnly: "Only the tail of the log is shown",

    aboutDesc: "View the MAIN version and manually check GitHub Release updates.",
    appName: "App Name",
    appIconStyle: "App Icon",
    appIconLight: "White background, black M",
    appIconDark: "Black background, white M",
    appIconApplyFailed: "The app icon preference was saved, but the current system icon could not update immediately. MAIN will try again on restart.",
    unknownVersion: "Unknown",
    latestCheck: "Last checked",
    neverChecked: "Never checked",
    noUpdateChecked: "Click Check for Updates to fetch the public release manifest and verify signed updater packages.",
    updateReadyDesc: (version: string) => `MAIN ${version} is available. Install it and restart when ready.`,
    updateUpToDateDesc: "You are on the latest public version.",
    updateInstallingDesc: "MAIN will relaunch automatically after the update is installed.",
    updateErrorDesc: "The check or install failed. Try again later, or inspect main.update in the debug log.",
    openGitHubReleases: "Open GitHub Releases",
    openGitHubReleasesDesc: "View the public download page in your browser.",
    openGitHubReleasesFailed: "Could not open the GitHub Releases page.",

    compressionLow: "Memory Saver",
    compressionBalanced: "Balanced",
    compressionLong: "Long Context",
    compressionLowHint: "Compress earlier for tighter VRAM budgets",
    compressionBalancedHint: "Balance context retention and VRAM use",
    compressionLongHint: "Compress later and keep more history",
    zoneLow: "Memory saver / earlier compression",
    zoneBalanced: "Balanced",
    zoneLong: "Long context / later compression",
    contextTriggerThreshold: "Compression Trigger (Tokens)",
    estimatedContextVram: "Estimated Context VRAM",
    currentLimit: (tokens: string) => `Current limit is about ${tokens} tokens`,
    deviceMemory: "Device Memory",
    available: "available",
    maxBar: (value: string, hasSafety: boolean) => `Full scale is about ${value}${hasSafety ? ", with a safety margin reserved from current available memory" : ""}`,
    contextTip: "This setting controls local-model background compression and context window size. Full scale is calculated from current available memory with about 1 GB / 10% reserved as a safety margin.",

    providerEngine: "Provider Engine",
    apiEndpoint: "API Endpoint",
    apiKeyOptionalOmlx: "API Key",
    optionalOmlxAuth: "optional, for OMLX service auth",
    noAuthPlaceholder: "Leave blank to skip the auth header",
    localModel: "Local Model",
    localModelUnselected: "No model selected",
    scanningModels: "Scanning models...",
    noModels: "No models found - start the local inference service first",
    scanModels: "Scan",
    discoveredModels: (count: number) => `Found ${count} model(s)`,
    localFetchError: "Unable to fetch models. Check the service address and network connection.",

    cloudDesc: "Manage multiple cloud server configurations. Save after creating or editing; model lists are fetched only when you refresh.",
    cloudLab: "Lab",
    cloudLabDesc: "Only API Key settings are shown by default. Enable this to reveal experimental OpenAI / Gemini account-login entries.",
    cloudLabOn: "Experimental entries visible",
    cloudLabOff: "API Key only",
    modelName: "Model Name",
    currentServer: "Current server: ",
    unnamedServer: "Unnamed server",
    unsaved: "Unsaved",
    manualInput: "Manual Input",
    dropdownSelect: "Use Dropdown",
    refreshing: "Refreshing...",
    fetchedModels: (count: number) => `Fetched ${count} model(s)`,
    noCloudServerTitle: "No cloud servers yet",
    noCloudServerDesc: "Add a server from the left, then refresh the model list here.",
    servers: "Servers",
    configs: (count: number) => `${count} config(s)`,
    addServerTitle: "Add Server",
    serverSearchPlaceholder: "Search name, endpoint, or model",
    noServerConfigs: "No server configurations",
    noMatchingServers: "No matching servers",
    unsavedServer: "Unsaved server",
    noEndpoint: "Endpoint missing",
    serverConfig: "Server Configuration",
    unsavedChanges: "Unsaved changes",
    savedConfig: "Current server configuration is saved",
    cloudServerName: "Server Name",
    cloudServerNamePlaceholder: "For example OpenAI / OpenRouter / company gateway",
    apiProtocol: "API Protocol",
    apiProtocolDesc: "Choose the cloud service protocol. Aggregators usually use OpenAI Compatible; native Claude endpoints use Anthropic.",
    apiFormat: "API Format",
    apiFormatDesc: "Try Chat Completions for loosely compatible gateways. If the service uses `wire_api = responses`, switch to Responses API.",
    apiFormatLockedByOpenAiOAuth: "OpenAI experimental login is fixed to Responses API.",
    responsesEndpointPlaceholder: "https://api.openai.com/v1 or a full /v1/responses URL",
    chatEndpointPlaceholder: "https://api.openai.com/v1 or a full /v1/chat/completions URL",
    anthropicEndpointHint: "Anthropic usually uses the root URL, for example https://api.anthropic.com.",
    geminiCodeAssistEndpointHint: "Gemini login uses the Google Code Assist compatible route and automatically targets cloudcode-pa.googleapis.com; only API Key mode uses the Gemini API endpoint.",
    responsesEndpointHint: "Responses API accepts an API root URL such as https://api.openai.com/v1, or a full /responses request URL.",
    chatEndpointHint: "OpenAI Chat Completions usually uses an API root URL ending in /v1, or a full /chat/completions URL.",
    apiKeyOptional: "leave blank if the service does not require one",
    apiKeyDescAnthropic: "Anthropic protocol sends the x-api-key header.",
    apiKeyDescOpenAi: "OpenAI-compatible protocol sends both Authorization: Bearer and x-api-key by default for broader gateway compatibility.",
    apiKeyDescGemini: "Gemini API Key uses the x-goog-api-key header.",
    authMethod: "Authentication",
    authMethodDesc: "API Key is the stable path.",
    authMethodDescLab: "API Key is the stable path. Account login is experimental; the frontend stores only a token reference.",
    authApiKey: "API Key",
    authOpenAiLogin: "OpenAI Login",
    authGeminiLogin: "Gemini Login",
    openAiExperimentalLoginTitle: "ChatGPT Pro/Plus/Codex Experimental Login",
    openAiExperimentalLoginDesc: "Uses system-browser OpenAI OAuth, a local callback, and the ChatGPT/Codex compatible endpoint. Free-account availability is not promised.",
    geminiExperimentalLoginTitle: "Gemini Google Experimental Login",
    geminiExperimentalLoginDesc: "Uses Google OAuth for the Gemini Code Assist compatible route, without reusing gemini.google.com web sessions or calling the Gemini API Key endpoint directly.",
    geminiCloudProjectHint: "Some Workspace, enterprise, or Code Assist accounts may require GOOGLE_CLOUD_PROJECT.",
    login: "Log In",
    loggingIn: "Logging in...",
    logout: "Log Out",
    authConnected: "Signed in",
    authPending: "Waiting for browser authorization...",
    authDisconnected: "Not signed in",
    authExpired: "Sign-in expired",
    authStorageFile: "Token is stored in the local app data file with 0600 permissions, not the OS keychain.",
    authStorageKeychain: "Token is stored in the OS keychain.",
    authStartFailed: (message: string) => `Could not start login: ${message}`,
    authFinishFailed: (message: string) => `Could not finish login: ${message}`,
    authLogoutFailed: (message: string) => `Could not log out: ${message}`,
    authBrowserFallback: "The browser did not open automatically. Open the authorization URL manually.",
    authManualOpen: "Open Authorization URL",
    additionalHeaders: "Additional Headers (JSON)",
    optional: "optional",
    additionalHeadersDesc: "Use a JSON object, or a {\"header\",\"value\"} array, when a vendor requires custom request headers.",
    customHeadersCount: (count: number) => `${count} custom header(s) will be attached`,
    advancedCompatibility: "Detailed Settings",
    advancedCompatibilityDesc: "Headers, API format, tool protocol, response storage, and reasoning compatibility options.",
    reasoningEffort: "Reasoning Effort",
    reasoningEffortDesc: "Keep this at None for the fastest responses and fewer cloud 524s. Switch to High / XHigh only for complex reasoning tasks.",
    disableResponseStorage: "Disable Response Storage",
    disableResponseStorageDesc: "Maps to Codex `disable_response_storage = true` and sends `store: false`.",
    toolProtocol: "Tool Protocol",
    toolProtocolDesc: "Auto tries native tools first and falls back to XML on weak gateways. Native forces function calling; XML uses text tool calls directly.",
    localToolProtocolOllamaHint: "Ollama keeps using /api/chat text tools and will not receive OpenAI native tools parameters.",
    responsesCodexDesc: "`Responses + gpt-5.4` now mirrors Codex request shape where possible: top-level `instructions`, `store: false` / `reasoning.effort`, and server defaults for sampling.",
    cloudStartTitle: "Add a cloud server from scratch",
    cloudStartDesc: "No cloud API configuration exists yet. Add a server, then fill in name, protocol, endpoint, and API key.",
    cloudSaveRequired: "Fill Server Name and API Endpoint first",
    cloudSaved: "Server configuration saved",
    cloudSelectServerFirst: "Create or select a server first",
    cloudEndpointRequired: "Fill API Endpoint first",
    cloudModelsPulled: (count: number, model: string) => `Fetched ${count} model(s); selected ${model}`,
    cloudOpenAiProbeFallbackWarning: (model: string) => `Model list refreshed, but login probing could not find a stable model. Kept current selection ${model}; run Test or sign in again.`,
    cloudNoModels: "No available models found. Check endpoint, protocol, and API key.",
    cloudConnectionFailed: (message: string) => `Connection failed: ${message}`,
    cloudModelRequired: "Select or enter a model name first",
    cloudAutoSwitch: (format: string) => `, automatically switched to ${format}`,
    cloudConnected: (model: string, switched: string) => `Connected to ${model}${switched}`,
    cloudBasicSuccessWithReply: (model: string, reply: string, switched: string) => `Basic connection succeeded; ${model} replied: ${reply}${switched}.`,
    cloudBasicSuccess: (model: string, switched: string) => `Basic connection succeeded; ${model} returned a valid response${switched}.`,
    cloudAdvancedSuccess: "Advanced parameters passed too: store/reasoning are compatible with the current configuration.",
    cloudAdvancedWarning: (message: string) => `The basic connection works, but store/reasoning advanced parameters failed: ${message}. Real tasks will still use the current configuration; if this is flaky, lower Reasoning Effort or set it to None.`,
    cloudProtocolHint: " This cloud service appears not to support Anthropic /v1/messages. Switch to OpenAI Compatible and try again.",
    cloudRetryHint: " This is usually a temporary cloud-gateway or upstream-model issue. MAIN already retried automatically; trying again later often fixes it.",
    cloudTestFailed: (message: string, protocolHint: string, retryHint: string) => `Test failed: ${message}${protocolHint}${retryHint}`,
  },
} as const;

// ── MCP Server Management Panel ──────────────────────────────────────────

function formatMcpTemplate(template: string | undefined, values: Record<string, string | number>) {
  if (!template) return "";
  return template.replace(/\{(\w+)\}/g, (_match, key) => String(values[key] ?? `{${key}}`));
}

type McpTestUiState = {
  phase: "testing" | "success" | "error";
  category?: MCPDiagnosticCategory;
  message: string;
  toolCount: number;
};

function McpServerPanel({
  mcpServers,
  setMcpServers,
  mcpDiscoveredTools,
  setMcpDiscoveredTools,
  language,
  t,
}: {
  mcpServers: MCPServer[];
  setMcpServers: (servers: MCPServer[]) => void;
  mcpDiscoveredTools: MCPTool[];
  setMcpDiscoveredTools: (tools: MCPTool[], toolServerMap: Record<string, string>) => void;
  language: "zh" | "en";
  t: any;
}) {
  const copy = {
    ...SETTINGS_COPY[language],
    mcpServerTitle: t.mcpServers || SETTINGS_COPY[language].mcpServerTitle,
    mcpScanTools: t.mcpScanTools || SETTINGS_COPY[language].mcpScanTools,
    mcpScanning: t.mcpScanning || SETTINGS_COPY[language].mcpScanning,
    mcpDescription: t.mcpDescription || SETTINGS_COPY[language].mcpDescription,
    mcpNoServersConfigured: t.mcpNoServersConfigured || SETTINGS_COPY[language].mcpNoServersConfigured,
    mcpNoServersHint: t.mcpNoServersHint || SETTINGS_COPY[language].mcpNoServersHint,
    remove: t.mcpRemoveServer || SETTINGS_COPY[language].remove,
    addServer: t.mcpAddServer || SETTINGS_COPY[language].addServer,
    serverNamePlaceholder: t.mcpServerNamePlaceholder || SETTINGS_COPY[language].serverNamePlaceholder,
    add: t.mcpAdd || SETTINGS_COPY[language].add,
    discoveredTools: t.mcpDiscoveredTools || SETTINGS_COPY[language].discoveredTools,
    mcpDiscovered: (toolCount: number, serverCount: number) =>
      t.mcpDiscoveredMessage
        ? formatMcpTemplate(t.mcpDiscoveredMessage, { toolCount, serverCount })
        : SETTINGS_COPY[language].mcpDiscovered(toolCount, serverCount),
    mcpNoServers: t.mcpNoServers || SETTINGS_COPY[language].mcpNoServers,
    mcpNoTools: t.mcpNoTools || SETTINGS_COPY[language].mcpNoTools,
    mcpDiscoveryFailed: (message: string) =>
      t.mcpDiscoveryFailedMessage
        ? formatMcpTemplate(t.mcpDiscoveryFailedMessage, { message })
        : SETTINGS_COPY[language].mcpDiscoveryFailed(message),
    mcpTip: t.mcpTip || SETTINGS_COPY[language].mcpTip,
    mcpTestingStatus: t.mcpTestingStatus || SETTINGS_COPY[language].mcpTestingStatus,
    mcpTestSuccess: SETTINGS_COPY[language].mcpTestSuccess,
    mcpTestEmptyTools: t.mcpTestEmptyTools || SETTINGS_COPY[language].mcpTestEmptyTools,
    mcpTestUnreachable: t.mcpTestUnreachable || SETTINGS_COPY[language].mcpTestUnreachable,
    mcpTestRouteMismatch: t.mcpTestRouteMismatch || SETTINGS_COPY[language].mcpTestRouteMismatch,
    mcpTestHeaderMismatch: t.mcpTestHeaderMismatch || SETTINGS_COPY[language].mcpTestHeaderMismatch,
    mcpTestRpcError: SETTINGS_COPY[language].mcpTestRpcError,
    mcpTestHttpError: SETTINGS_COPY[language].mcpTestHttpError,
    mcpTestInvalidResponse: t.mcpTestInvalidResponse || SETTINGS_COPY[language].mcpTestInvalidResponse,
    mcpTestFailed: SETTINGS_COPY[language].mcpTestFailed,
  };
  const [isDiscovering, setIsDiscovering] = useState(false);
  const [discoverMsg, setDiscoverMsg] = useState<(
    | { kind: "discovered"; type: "success"; toolCount: number; serverCount: number }
    | { kind: "noServers" | "noTools"; type: "error" }
    | { kind: "failed"; type: "error"; message: string }
  ) | null>(null);
  const [testStateByServer, setTestStateByServer] = useState<Record<string, McpTestUiState>>({});
  // Form state for adding a new server
  const [newName, setNewName] = useState("");
  const [newUrl, setNewUrl] = useState("http://localhost:8080/mcp");
  const enabledMcpServerCount = mcpServers.filter((server) => server.enabled !== false).length;
  const tipSeparator = language === "zh" ? "：" : ": ";
  const tipEnd = language === "zh" ? "。" : ".";

  const getDiscoverMsgText = () => {
    if (!discoverMsg) return "";
    if (discoverMsg.kind === "discovered") return copy.mcpDiscovered(discoverMsg.toolCount, discoverMsg.serverCount);
    if (discoverMsg.kind === "noServers") return copy.mcpNoServers;
    if (discoverMsg.kind === "noTools") return copy.mcpNoTools;
    return copy.mcpDiscoveryFailed(discoverMsg.message);
  };

  const getTestResultMessage = (result: MCPServerTestResult) => {
    if (result.ok) return copy.mcpTestSuccess(result.toolCount);
    if (result.category === "empty_tools") return copy.mcpTestEmptyTools;
    if (result.category === "unreachable") return copy.mcpTestUnreachable;
    if (result.category === "route_mismatch") return copy.mcpTestRouteMismatch;
    if (result.category === "header_mismatch") return copy.mcpTestHeaderMismatch;
    if (result.category === "rpc_error") return copy.mcpTestRpcError(result.message);
    if (result.category === "http_error") return copy.mcpTestHttpError(result.status ?? 0);
    if (result.category === "invalid_response") return copy.mcpTestInvalidResponse;
    return copy.mcpTestFailed(result.message);
  };

  // Auto-clear discovery message after 5 seconds
  useEffect(() => {
    if (!discoverMsg) return;
    const timer = setTimeout(() => setDiscoverMsg(null), 5000);
    return () => clearTimeout(timer);
  }, [discoverMsg]);

  useEffect(() => {
    const activeNames = new Set(mcpServers.map((server) => server.name));
    setTestStateByServer((prev) => {
      const next = Object.fromEntries(
        Object.entries(prev).filter(([name]) => activeNames.has(name))
      ) as Record<string, McpTestUiState>;
      return Object.keys(next).length === Object.keys(prev).length ? prev : next;
    });
  }, [mcpServers]);

  const handleDiscover = async () => {
    setIsDiscovering(true);
    setDiscoverMsg(null);
    try {
      const { tools, toolServerMap } = await discoverAllMcpTools(mcpServers);
      setMcpDiscoveredTools(tools, toolServerMap);
      setMcpToolServerMap(toolServerMap);
      if (tools.length > 0) {
        setDiscoverMsg({ kind: "discovered", type: "success", toolCount: tools.length, serverCount: enabledMcpServerCount });
      } else if (enabledMcpServerCount === 0) {
        setDiscoverMsg({ kind: "noServers", type: "error" });
      } else {
        setDiscoverMsg({ kind: "noTools", type: "error" });
      }
    } catch (err) {
      setDiscoverMsg({ kind: "failed", type: "error", message: err instanceof Error ? err.message : String(err) });
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
    setMcpServers([...mcpServers, { name, type: "http", url, enabled: true }]);
    setNewName("");
    setNewUrl("http://localhost:8080/mcp");
  };

  const handleToggleServer = (name: string, enabled: boolean) => {
    setMcpServers(mcpServers.map((server) => server.name === name ? { ...server, enabled } : server));
  };

  const handleTestServer = async (server: MCPServer) => {
    setTestStateByServer((prev) => ({
      ...prev,
      [server.name]: {
        phase: "testing",
        message: copy.mcpTestingStatus,
        toolCount: 0,
      },
    }));

    const result = await testMcpServer(server);
    const nextState: McpTestUiState = {
      phase: result.ok ? "success" : "error",
      category: result.category,
      message: getTestResultMessage(result),
      toolCount: result.toolCount,
    };
    setTestStateByServer((prev) => ({ ...prev, [server.name]: nextState }));
    console.log("[MCP] Server test result", {
      server: server.name,
      url: server.url,
      ok: result.ok,
      category: result.category,
      status: result.status,
      toolCount: result.toolCount,
    });
  };

  const handleRemoveServer = (name: string) => {
    setMcpServers(mcpServers.filter(s => s.name !== name));
    setTestStateByServer((prev) => {
      if (!(name in prev)) return prev;
      const next = { ...prev };
      delete next[name];
      return next;
    });
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h3 className="text-[13px] font-bold text-[#a1a1aa] uppercase tracking-wider">{copy.mcpServerTitle}</h3>
        <button
          onClick={handleDiscover}
          disabled={isDiscovering}
          className="px-3 py-1.5 text-[12px] font-bold bg-[#18181b] text-[#a1a1aa] hover:text-white border border-[#27272a] rounded-md transition-colors shrink-0 disabled:opacity-50"
        >
          {isDiscovering ? copy.mcpScanning : copy.mcpScanTools}
        </button>
      </div>

      <p className="text-[11.5px] text-[#71717a] leading-relaxed">
        {copy.mcpDescription}
      </p>

      {/* ── Server list ────────────────────────────────────── */}
      <div className="space-y-2">
        {mcpServers.length === 0 ? (
          <div className="bg-[#000000] border border-[#27272a] border-dashed rounded-lg p-6 text-center">
            <p className="text-[12px] text-[#71717a]">{copy.mcpNoServersConfigured}</p>
            <p className="text-[11px] text-[#3f3f46] mt-1">{copy.mcpNoServersHint}</p>
          </div>
        ) : (
          mcpServers.map((server) => {
            const enabled = server.enabled !== false;
            const serverTestState = testStateByServer[server.name];
            const isTestingServer = serverTestState?.phase === "testing";
            return (
            <div
              key={server.name}
              className="bg-[#000000] border border-[#27272a] rounded-lg p-4 flex items-center justify-between group"
            >
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className={`inline-block w-2 h-2 rounded-full shrink-0 ${enabled ? "bg-[#22c55e]" : "bg-[#3f3f46]"}`} title="HTTP" />
                  <span className="text-[13px] font-bold text-[#e4e4e7] truncate">{server.name}</span>
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-[#18181b] text-[#71717a] border border-[#27272a] uppercase font-mono">HTTP</span>
                  <span className={`text-[10px] px-1.5 py-0.5 rounded border font-bold ${enabled ? "theme-subtle-border theme-subtle-bg" : "border-[#27272a] bg-[#09090b] text-[#71717a]"}`}>
                    {enabled ? copy.mcpEnabled : copy.mcpDisabled}
                  </span>
                </div>
                <p className="text-[11px] text-[#71717a] font-mono mt-1 truncate">{server.url}</p>
                {serverTestState && (
                  <p
                    className={`mt-1 text-[11px] ${
                      serverTestState.phase === "success"
                        ? "text-[#86d9a3]"
                        : serverTestState.phase === "testing"
                          ? "text-[#a1a1aa]"
                          : "text-[#f48771]"
                    }`}
                  >
                    {serverTestState.message}
                  </p>
                )}
              </div>
              <div className="ml-4 flex shrink-0 items-center gap-3">
                <button
                  type="button"
                  role="switch"
                  aria-checked={enabled}
                  aria-label={`${server.name} ${enabled ? copy.mcpEnabled : copy.mcpDisabled}`}
                  onClick={() => handleToggleServer(server.name, !enabled)}
                  className={`relative inline-flex h-6 w-11 items-center rounded-full border p-0.5 transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[#000000] ${
                    enabled ? "border-transparent shadow-[0_0_12px_var(--accent-subtle)]" : "border-[#3f3f46] bg-[#18181b]"
                  }`}
                  style={enabled ? { backgroundColor: "var(--accent)" } : undefined}
                  title={enabled ? copy.mcpEnabled : copy.mcpDisabled}
                >
                  <span
                    className={`block h-5 w-5 rounded-full bg-white shadow-sm transition-transform duration-200 ${
                      enabled ? "translate-x-5" : "translate-x-0"
                    }`}
                  />
                </button>
                <button
                  onClick={() => handleTestServer(server)}
                  disabled={isTestingServer}
                  data-testid={`mcp-test-${server.name}`}
                  className="h-7 min-w-[44px] rounded-md border border-[#27272a] bg-[#18181b] px-2.5 text-[11px] font-bold text-[#a1a1aa] transition-colors hover:text-white disabled:cursor-not-allowed disabled:opacity-50"
                  title={copy.test}
                  aria-label={`${copy.test} ${server.name}`}
                >
                  {isTestingServer ? copy.testing : copy.test}
                </button>
                <button
                  onClick={() => handleRemoveServer(server.name)}
                  className="flex h-7 w-7 items-center justify-center rounded-md border border-transparent text-[#71717a] transition-colors hover:border-[#3f1f1f] hover:bg-[#181111] hover:text-[#f87171]"
                  title={copy.remove}
                  aria-label={copy.remove}
                >
                  <IconTrash className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>
            );
          })
        )}
      </div>

      {/* ── Add server form ────────────────────────────────── */}
      <div className="bg-[#000000] border border-[#27272a] rounded-lg p-4 space-y-3">
        <p className="text-[12px] font-bold text-[#a1a1aa]">{copy.addServer}</p>
        <div className="flex gap-2">
          <input
            type="text"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder={copy.serverNamePlaceholder}
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
            {copy.add}
          </button>
        </div>
      </div>

      {/* ── Discovery result ───────────────────────────────── */}
      {discoverMsg && (
        <p className={`text-[12px] ${discoverMsg.type === 'error' ? 'text-[#f48771]' : 'text-[#86d9a3]'}`}>
          {getDiscoverMsgText()}
        </p>
      )}

      {/* ── Discovered tools ───────────────────────────────── */}
      {mcpDiscoveredTools.length > 0 && (
        <div className="space-y-2">
          <p className="text-[12px] font-bold text-[#a1a1aa] uppercase tracking-wider">{copy.discoveredTools} ({mcpDiscoveredTools.length})</p>
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
          <span className="text-[#a1a1aa]">{copy.tipLabel}</span>{tipSeparator}{copy.mcpTip} <span className="font-mono text-[#a1a1aa]">http://localhost:8080/mcp</span>{tipEnd}
        </p>
      </div>
    </div>
  );
}

// ── Data Management Panel ────────────────────────────────────────────

function DataManagerPanel({ t, language }: { t: any; language: "zh" | "en" }) {
  const copy = SETTINGS_COPY[language];
  const clearChatHistory = useAppStore((s) => s.clearChatHistory);
  const resetAllSettings = useAppStore((s) => s.resetAllSettings);
  const [confirmClear, setConfirmClear] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);

  return (
    <div className="space-y-6">
      <h3 className="text-[13px] font-bold text-[#a1a1aa] uppercase tracking-wider">{t.dataManagement}</h3>

      <p className="text-[11.5px] text-[#71717a] leading-relaxed">
        {copy.dataPanelDesc}
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
              {copy.confirmClear}
            </button>
            <button
              onClick={() => setConfirmClear(false)}
              className="px-4 py-2 text-[12px] font-bold bg-[#18181b] text-[#a1a1aa] border border-[#27272a] rounded-md hover:text-white transition-colors"
            >
              {copy.cancel}
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
              {copy.confirmReset}
            </button>
            <button
              onClick={() => setConfirmReset(false)}
              className="px-4 py-2 text-[12px] font-bold bg-[#18181b] text-[#a1a1aa] border border-[#27272a] rounded-md hover:text-white transition-colors"
            >
              {copy.cancel}
            </button>
          </div>
        )}
      </div>

      {/* Tip */}
      <div className="p-3 bg-[#000000] border border-[#27272a] rounded-md">
        <p className="text-[11px] text-[#71717a] leading-relaxed">
          <span className="text-[#a1a1aa]">{copy.tipLabel}</span>：{copy.dataTip}
        </p>
      </div>
    </div>
  );
}

function DebugLogPanel({
  t,
  language,
  config,
  setConfig,
}: {
  t: any;
  language: "zh" | "en";
  config: any;
  setConfig: (patch: any) => void;
}) {
  const copy = SETTINGS_COPY[language];
  const [snapshot, setSnapshot] = useState({ path: "", content: "", truncated: false });
  const [status, setStatus] = useState("");
  const recordFullTurnProcess = config.debugRecordFullTurnProcess === true;

  const refresh = useCallback(async () => {
    const next = await readDebugLogSnapshot(1024 * 1024);
    setSnapshot(next);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const logText = snapshot.content || "";

  const handleCopy = async () => {
    await copyDebugLogToClipboard(logText || copy.noDebugLog);
    setStatus(copy.copiedDebugLog);
    window.setTimeout(() => setStatus(""), 1800);
  };

  const handleExport = async () => {
    const filePath = await save({
      defaultPath: `main-debug-${new Date().toISOString().replace(/[:.]/g, "-")}.log`,
      filters: [{ name: "Log", extensions: ["log", "txt"] }],
    });
    if (!filePath) return;
    await exportTextFile(filePath, logText || copy.noDebugLog);
    setStatus(copy.exportedDebugLog);
    window.setTimeout(() => setStatus(""), 1800);
  };

  const handleClear = async () => {
    await clearDebugLog();
    await refresh();
    setStatus(copy.clearedDebugLog);
    window.setTimeout(() => setStatus(""), 1800);
  };

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h3 className="text-[13px] font-bold text-[#a1a1aa] uppercase tracking-wider">{t.debugLog}</h3>
          <p className="mt-1 text-[11.5px] text-[#71717a] leading-relaxed">
            {copy.debugDesc}
          </p>
        </div>
        <button
          onClick={refresh}
          className="shrink-0 rounded-md border border-[#27272a] bg-[#18181b] px-3 py-1.5 text-[12px] font-bold text-[#a1a1aa] transition-colors hover:text-white"
        >
          {copy.refresh}
        </button>
      </div>

      <div className="flex items-center justify-between gap-4 rounded-lg border border-[#27272a] bg-[#000000] px-4 py-3">
        <div>
          <p className="text-[12.5px] font-bold text-[#e4e4e7]">{copy.debugRecordFullTurnProcess}</p>
          <p className="mt-1 text-[11.5px] leading-relaxed text-[#a1a1aa]">{copy.debugRecordFullTurnProcessDesc}</p>
        </div>
        <div className="flex items-center gap-3">
          <span className={`text-[12px] font-bold ${recordFullTurnProcess ? "theme-text" : "text-[#a1a1aa]"}`}>
            {recordFullTurnProcess ? copy.enabled : copy.disabled}
          </span>
          <button
            type="button"
            role="switch"
            aria-checked={recordFullTurnProcess}
            data-testid="debug-full-turn-process-switch"
            aria-label={copy.debugRecordFullTurnProcess}
            onClick={() => setConfig({ ...config, debugRecordFullTurnProcess: !recordFullTurnProcess })}
            className={`relative inline-flex h-6 w-11 items-center rounded-full border p-0.5 transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[#000000] ${
              recordFullTurnProcess
                ? "border-transparent shadow-[0_0_12px_var(--accent-subtle)]"
                : "border-[#3f3f46] bg-[#18181b]"
            }`}
            style={recordFullTurnProcess ? { backgroundColor: "var(--accent)" } : undefined}
          >
            <span
              className={`block h-5 w-5 rounded-full bg-white shadow-sm transition-transform duration-200 ${
                recordFullTurnProcess ? "translate-x-5" : "translate-x-0"
              }`}
            />
          </button>
        </div>
      </div>

      <div className="rounded-lg border border-[#27272a] bg-[#000000] p-3">
        <div className="mb-2 text-[11px] font-bold text-[#a1a1aa]">{copy.debugFile}</div>
        <div className="break-all font-mono text-[11px] text-[#71717a]">{snapshot.path || "localStorage:main.debugLog.v1"}</div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <button onClick={handleCopy} className="rounded-md border border-[#27272a] bg-[#18181b] px-3 py-2 text-[12px] font-bold text-[#e4e4e7] transition-colors hover:border-[#3f3f46]">
          {copy.copyLog}
        </button>
        <button onClick={handleExport} className="rounded-md border border-[#27272a] bg-[#18181b] px-3 py-2 text-[12px] font-bold text-[#e4e4e7] transition-colors hover:border-[#3f3f46]">
          {copy.exportLog}
        </button>
        <button onClick={handleClear} className="rounded-md border border-[#3f1f1f] bg-[#181111] px-3 py-2 text-[12px] font-bold text-[#fca5a5] transition-colors hover:border-[#7f1d1d]">
          {copy.clearLog}
        </button>
        {status && <span className="text-[12px] text-[#86d9a3]">{status}</span>}
        {snapshot.truncated && <span className="text-[12px] text-[#fbbf24]">{copy.logTailOnly}</span>}
      </div>

      <textarea
        readOnly
        value={logText || copy.noDebugLog}
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
        "Enable event subscription by long connection and subscribe to im.message.receive_v1 plus card.action.trigger.",
        "Grant message receive and bot message send permissions, then publish or install the app in the tenant.",
        "Copy the App ID and App Secret from the app credentials page.",
      ]
    : [
        "打开飞书开放平台控制台，创建一个企业自建应用。",
        "启用机器人能力，并把机器人添加到你的飞书账号。",
        "开启事件订阅的长连接模式，订阅 im.message.receive_v1 和 card.action.trigger 事件。",
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
        "Describe tasks naturally; MAIN will answer or ask for operation approval when real tools are needed. Use /plan only when you explicitly want a review-first plan flow.",
        "/status: show adapter, MAIN and workspace status.",
        "/stop: stop current generation and clear queued remote messages.",
        "Remote approvals appear as interactive cards. Use the card buttons to allow or reject tool actions.",
        "/approve CODE or /reject CODE remains available only as a fallback if cards cannot be delivered.",
        "If replies fail with 400, check the bot message-send permission and whether the bot can send private messages to you.",
      ]
    : [
        "普通文本：默认在 MAIN 当前工作区执行只读分析。",
        "直接用自然语言描述任务；MAIN 会自然回复，真正需要操作时会先请求批准。只有你想明确走“先审阅方案”时再用 /计划。",
        "/status：查看飞书适配器、MAIN 和工作区状态。",
        "/stop：停止当前生成，并清空远程队列。",
        "远程审批会以交互式卡片出现，请直接点击卡片按钮允许或拒绝工具执行。",
        "/approve CODE 或 /reject CODE 仅作为卡片无法送达时的备用方式。",
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
      await writePty(buildNodeSetupCommand(language) + "\n", undefined, undefined, true);
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
  appVersion,
  updateStatus = "idle",
  availableUpdateVersion = "",
  availableUpdateNotes = "",
  updateError = "",
  updateProgressPercent = null,
  lastUpdateCheckedAt = null,
  onCheckForUpdate,
  onInstallUpdate,
  modelRuntimeLock,
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
  appVersion?: string;
  updateStatus?: SettingsUpdateStatus;
  availableUpdateVersion?: string;
  availableUpdateNotes?: string;
  updateError?: string;
  updateProgressPercent?: number | null;
  lastUpdateCheckedAt?: number | null;
  onCheckForUpdate?: () => void;
  onInstallUpdate?: () => void;
  modelRuntimeLock?: {
    isLocked: boolean;
    activeProfile?: "local" | "cloud";
    activeCloudServerId?: string;
    reason?: string;
  };
}) {
  const [availableModels, setAvailableModels] = useState([]);
  const [cloudModelsByServer, setCloudModelsByServer] = useState<Record<string, string[]>>({});
  const [cloudServerSearch, setCloudServerSearch] = useState("");
  const [cloudDraftServer, setCloudDraftServer] = useState<any | null>(null);
  const [cloudDraftMode, setCloudDraftMode] = useState<"saved" | "new" | null>(null);
  const [isCloudAdvancedOpen, setIsCloudAdvancedOpen] = useState(false);
  const [isLocalAdvancedOpen, setIsLocalAdvancedOpen] = useState(false);
  const [cloudAuthBusy, setCloudAuthBusy] = useState(false);
  const [cloudAuthSession, setCloudAuthSession] = useState<any | null>(null);
  const [cloudAuthMsg, setCloudAuthMsg] = useState<{ text: string; type: 'success' | 'warning' | 'error' } | null>(null);
  const [cloudOpenAiLastGoodModelByServer, setCloudOpenAiLastGoodModelByServer] = useState<Record<string, string>>({});
  const [isFetchingModels, setIsFetchingModels] = useState(false);
  const [isFetchingCloudModels, setIsFetchingCloudModels] = useState(false);
  const [isTestingCloudConnection, setIsTestingCloudConnection] = useState(false);
  const [cloudModelInputMode, setCloudModelInputMode] = useState<"select" | "manual">("manual");
  const [cloudFetchMsg, setCloudFetchMsg] = useState<{ text: string; type: 'success' | 'warning' | 'error' } | null>(null);
  const [cloudProbeMsg, setCloudProbeMsg] = useState<{ text: string; type: 'success' | 'warning' | 'error' } | null>(null);
  const [cloudConnectionStatus, setCloudConnectionStatus] = useState<{
    fingerprint: string;
    model: string;
    text: string;
  } | null>(null);
  const [cloudSaveMsg, setCloudSaveMsg] = useState<{ text: string; type: 'success' | 'error' } | null>(null);
  const [localFetchMsg, setLocalFetchMsg] = useState<{ text: string; type: 'success' | 'error' } | null>(null);
  const [systemMemory, setSystemMemory] = useState<{ total_gb: number; available_gb: number; total_bytes?: number; available_bytes?: number } | null>(null);
  const [draftAppIconVariant, setDraftAppIconVariant] = useState<AppIconVariant>(() => normalizeAppIconVariant(config.appIconVariant));
  const [appIconApplyMsg, setAppIconApplyMsg] = useState<{ text: string; type: 'warning' } | null>(null);
  const [isApplyingAppIcon, setIsApplyingAppIcon] = useState(false);
  const hasAutoFetched = useRef(false);
  const skipNextLocalModelAutoPickRef = useRef(false);
  const cloudDraftServerRef = useRef<any | null>(null);
  const language = config.language === "en" ? "en" : "zh";
  const copy = {
    ...SETTINGS_COPY[language],
    mcpServerTitle: t.mcpServers || SETTINGS_COPY[language].mcpServerTitle,
    mcpScanning: t.mcpScanning || SETTINGS_COPY[language].mcpScanning,
  };
  const isModelRuntimeLocked = modelRuntimeLock?.isLocked === true;
  const modelRuntimeLockText = language === "zh"
    ? "模型正在执行中，当前执行模型配置已锁定。"
    : "A model run is active, so the current execution model is locked.";
  const canChangeCurrentModel = !isModelRuntimeLocked;
  const appIconOptions: Array<{ value: AppIconVariant; label: string; src: string }> = [
    { value: "light", label: copy.appIconLight, src: APP_ICON_ASSETS.light },
    { value: "dark", label: copy.appIconDark, src: APP_ICON_ASSETS.dark },
  ];
  const updateBusy = updateStatus === "checking" || updateStatus === "downloading" || updateStatus === "installing";
  const updateInstalling = updateStatus === "downloading" || updateStatus === "installing";
  const updateStatusText = (() => {
    if (updateStatus === "checking") return t.checkingForUpdates;
    if (updateStatus === "upToDate") return t.upToDate;
    if (updateStatus === "available" && availableUpdateVersion) return `${t.updateAvailable}: ${availableUpdateVersion}`;
    if (updateStatus === "downloading") return updateProgressPercent ? `${language === "en" ? "Downloading" : "下载中"} ${updateProgressPercent}%` : (language === "en" ? "Downloading..." : "下载中...");
    if (updateStatus === "installing") return language === "en" ? "Installing..." : "安装中...";
    if (updateStatus === "error") return t.updateCheckFailed;
    return copy.noUpdateChecked;
  })();
  const updateStatusDesc = (() => {
    if (updateStatus === "available" && availableUpdateVersion) return copy.updateReadyDesc(availableUpdateVersion);
    if (updateStatus === "upToDate") return copy.updateUpToDateDesc;
    if (updateInstalling) return copy.updateInstallingDesc;
    if (updateStatus === "error") return updateError || copy.updateErrorDesc;
    return copy.noUpdateChecked;
  })();
  const lastUpdateCheckedText = lastUpdateCheckedAt
    ? new Date(lastUpdateCheckedAt).toLocaleString()
    : copy.neverChecked;
  const releaseNotesSummary = summarizeReleaseNotes(availableUpdateNotes);
  const handleOpenGitHubReleases = useCallback(() => {
    void openUrl(MAIN_RELEASES_URL).catch((error) => {
      console.warn("Failed to open GitHub Releases", error);
      window.alert(copy.openGitHubReleasesFailed);
    });
  }, [copy.openGitHubReleasesFailed]);

  useEffect(() => {
    if (!isOpen) return;
    setDraftAppIconVariant(normalizeAppIconVariant(config.appIconVariant));
    setAppIconApplyMsg(null);
    setIsApplyingAppIcon(false);
  }, [config.appIconVariant, isOpen]);

  const handleCancelSettings = useCallback(() => {
    setDraftAppIconVariant(normalizeAppIconVariant(config.appIconVariant));
    setAppIconApplyMsg(null);
    setIsApplyingAppIcon(false);
    onClose();
  }, [config.appIconVariant, onClose]);

  const handleDoneSettings = useCallback(async () => {
    const nextVariant = normalizeAppIconVariant(draftAppIconVariant);
    const savedVariant = normalizeAppIconVariant(config.appIconVariant);
    setAppIconApplyMsg(null);
    if (nextVariant === savedVariant) {
      onClose();
      return;
    }

    setIsApplyingAppIcon(true);
    setConfig((prev: any) => ({
      ...prev,
      appIconVariant: nextVariant,
    }));

    try {
      await applyAppIconVariant(nextVariant);
      onClose();
    } catch (error) {
      console.warn("Failed to apply app icon variant", error);
      setAppIconApplyMsg({ text: copy.appIconApplyFailed, type: "warning" });
    } finally {
      setIsApplyingAppIcon(false);
    }
  }, [config.appIconVariant, copy.appIconApplyFailed, draftAppIconVariant, onClose, setConfig]);

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
    if (!cloudAuthMsg) return;
    const timer = setTimeout(() => setCloudAuthMsg(null), 5000);
    return () => clearTimeout(timer);
  }, [cloudAuthMsg]);

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
    if (!canChangeCurrentModel) return;
    const provider = e.target.value;
    skipNextLocalModelAutoPickRef.current = true;
    let endpoint = config.local.endpoint;
    if (provider === "LM Studio") endpoint = "http://127.0.0.1:1234/v1";
    if (provider === "Ollama") endpoint = "http://127.0.0.1:11434/v1";
    if (provider === "OMLX") endpoint = "http://127.0.0.1:8000/v1";
    setConfig({
      ...config,
      local: {
        ...config.local,
        provider,
        endpoint,
        model: "",
        toolProtocol: getDefaultLocalToolProtocol(provider),
      },
    });
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
    if (!canChangeCurrentModel) {
      setLocalFetchMsg({ text: modelRuntimeLockText, type: "error" });
      return;
    }
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
          if (!skipNextLocalModelAutoPickRef.current && !models.includes(config.local.model)) {
            setConfig(prev => ({ ...prev, local: { ...prev.local, model: models[0] } }));
          }
          skipNextLocalModelAutoPickRef.current = false;
          setLocalFetchMsg({ text: copy.discoveredModels(models.length), type: 'success' });
          setIsFetchingModels(false);
          return;
        }
      } catch {
        // Try next candidate URL
      }
    }

    setAvailableModels([]);
    skipNextLocalModelAutoPickRef.current = false;
    setLocalFetchMsg({ text: copy.localFetchError, type: 'error' });
    setIsFetchingModels(false);
  }, [canChangeCurrentModel, config, copy, modelRuntimeLockText]);

  // Auto-fetch models when local tab opens
  useEffect(() => {
    if (isOpen && settingsTab === 'local' && !hasAutoFetched.current && canChangeCurrentModel) {
      hasAutoFetched.current = true;
      fetchModels();
    }
    if (!isOpen) hasAutoFetched.current = false;
  }, [canChangeCurrentModel, isOpen, settingsTab]);

  // Re-fetch when provider or endpoint changes
  const prevProvider = useRef(config.local.provider);
  const prevEndpoint = useRef(config.local.endpoint);
  useEffect(() => {
    if (prevProvider.current !== config.local.provider || prevEndpoint.current !== config.local.endpoint) {
      prevProvider.current = config.local.provider;
      prevEndpoint.current = config.local.endpoint;
      if (hasAutoFetched.current && canChangeCurrentModel) {
        fetchModels(config.local.endpoint, config.local.provider);
      }
    }
  }, [canChangeCurrentModel, config.local.provider, config.local.endpoint, fetchModels]);

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
  const parsedCloudCustomHeaders = parseCloudCustomHeaders(draftCloudConfig.customHeaders || "");
  const cloudAuth = normalizeCloudAuth(draftCloudConfig.auth, cloudProtocol);
  const rawCloudAuthMode = normalizeCloudAuthMode(cloudAuth.mode);
  const cloudExperimentalLoginEnabled = config.cloudExperimentalLoginEnabled === true;
  const cloudAuthMode = cloudExperimentalLoginEnabled ? rawCloudAuthMode : "api_key";
  const cloudApiFormat = resolveEffectiveCloudApiFormat({
    protocol: cloudProtocol,
    apiFormat: draftCloudConfig.apiFormat,
    authMode: cloudAuthMode,
  });
  const cloudRuntimeAuth = cloudExperimentalLoginEnabled ? cloudAuth : createDefaultCloudAuth("api_key");
  const cloudUsesOAuth = cloudAuthMode !== "api_key";
  const cloudApiFormatLockedByOAuth = cloudProtocol === "openai" && cloudAuthMode === "openai_chatgpt_oauth";
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
  const cloudEndpointPlaceholder = cloudAuthMode === "gemini_google_oauth"
    ? "由 Gemini Code Assist 登录通道自动处理"
    : cloudProtocol === "anthropic"
    ? "https://api.anthropic.com"
    : cloudProtocol === "gemini"
      ? "https://generativelanguage.googleapis.com"
      : cloudApiFormat === "responses"
        ? copy.responsesEndpointPlaceholder
        : copy.chatEndpointPlaceholder;
  const cloudApiKeyPlaceholder = cloudProtocol === "anthropic" ? "sk-ant-..." : cloudProtocol === "gemini" ? "AIza..." : "sk-...";
  const cloudModelPlaceholder = cloudProtocol === "anthropic" ? "claude-sonnet-4-5" : cloudProtocol === "gemini" ? "gemini-2.5-pro" : "gpt-4.1 / qwen-max / openrouter-model";
  const cloudEndpointHint = cloudAuthMode === "gemini_google_oauth"
    ? copy.geminiCodeAssistEndpointHint
    : cloudProtocol === "anthropic"
    ? copy.anthropicEndpointHint
    : cloudProtocol === "gemini"
      ? "Gemini API root, for example https://generativelanguage.googleapis.com."
      : cloudApiFormat === "responses"
        ? copy.responsesEndpointHint
        : copy.chatEndpointHint;
  const cloudConnectionFingerprint = useMemo(() => buildCloudConnectionFingerprint({
    ...draftCloudConfig,
    auth: cloudRuntimeAuth,
  }, cloudApiFormat), [
    draftCloudConfig.apiKey,
    draftCloudConfig.auth,
    draftCloudConfig.customHeaders,
    draftCloudConfig.endpoint,
    draftCloudConfig.model,
    draftCloudConfig.protocol,
    cloudApiFormat,
    cloudExperimentalLoginEnabled,
  ]);
  const activeCloudConnectionStatus = cloudConnectionStatus?.fingerprint === cloudConnectionFingerprint
    ? cloudConnectionStatus
    : null;
  const lockedCloudServerId = modelRuntimeLock?.activeProfile === "cloud"
    ? String(modelRuntimeLock.activeCloudServerId || "")
    : "";
  const isLockedCloudDraftServer = Boolean(
    isModelRuntimeLocked &&
    lockedCloudServerId &&
    cloudDraftServer?.id === lockedCloudServerId,
  );
  const canEditCloudDraftServer = !isLockedCloudDraftServer;

  useEffect(() => {
    cloudDraftServerRef.current = cloudDraftServer;
  }, [cloudDraftServer]);

  useEffect(() => {
    if (cloudConnectionStatus && cloudConnectionStatus.fingerprint !== cloudConnectionFingerprint) {
      setCloudConnectionStatus(null);
    }
  }, [cloudConnectionFingerprint, cloudConnectionStatus]);

  useEffect(() => {
    if (cloudExperimentalLoginEnabled) return;
    setCloudAuthMsg(null);
    setCloudAuthSession(null);
  }, [cloudExperimentalLoginEnabled]);

  useEffect(() => {
    if (!isOpen || settingsTab !== "cloud") return;
    if (cloudDraftMode === "new") return;
    const nextDraft = savedActiveCloudServer ? { ...savedActiveCloudServer } : null;
    setCloudDraftServer(nextDraft);
    setCloudDraftMode(nextDraft ? "saved" : null);
    setCloudModelInputMode(nextDraft && (cloudModelsByServer[nextDraft.id] || []).length > 0 ? "select" : "manual");
    setCloudFetchMsg(null);
    setCloudProbeMsg(null);
    setCloudAuthMsg(null);
    setCloudAuthSession(null);
  }, [activeCloudServerId, cloudDraftMode, isOpen, savedActiveCloudServer, settingsTab]);

  const makeBlankCloudServerDraft = useCallback(() => ({
    id: `cloud-server-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    name: "",
    ...createDefaultCloudConfig(),
    endpoint: "",
    model: "",
    apiKey: "",
    customHeaders: "",
    auth: createDefaultCloudAuth("api_key"),
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

  const clearOpenAiProbeCache = useCallback((serverId?: string) => {
    if (!serverId) return;
    setCloudOpenAiLastGoodModelByServer((prev) => {
      if (!prev[serverId]) return prev;
      const next = { ...prev };
      delete next[serverId];
      return next;
    });
  }, []);

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
    const authMode = normalizeCloudAuthMode(server.auth?.mode);
    if (!name || (authMode === "api_key" && !endpoint)) return null;

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
      return commitCloudServers(
        nextServers,
        isModelRuntimeLocked ? state.activeCloudServerId : savedServer.id,
        prev,
      );
    });
    setCloudDraftServer({ ...savedServer });
    setCloudDraftMode("saved");
    return savedServer;
  }, [commitCloudServers, isModelRuntimeLocked, setConfig]);

  const confirmCloudModelSelection = useCallback((model, serverOverride = null) => {
    const sourceServer = serverOverride || cloudDraftServer;
    if (!sourceServer) return;
    if (isLockedCloudDraftServer && sourceServer.id === cloudDraftServer?.id) return;
    const nextModel = String(model || "").trim();
    const nextServer = { ...sourceServer, model: nextModel };

    setCloudDraftServer((prev) => prev && prev.id === sourceServer.id ? { ...prev, model: nextModel } : prev);
    setCloudSaveMsg(null);

    const isSavedServer = cloudServers.some((server) => server.id === sourceServer.id);
    const canPersistServer = isSavedServer || (String(sourceServer.name || "").trim() && String(sourceServer.endpoint || "").trim());
    if (canPersistServer) {
      persistCloudServer(nextServer);
    }
  }, [cloudDraftServer, cloudServers, isLockedCloudDraftServer, persistCloudServer]);

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
      disableResponseStorage: server.disableResponseStorage !== false,
      reasoningEffort: normalizeOpenAiReasoningEffort(server.reasoningEffort),
      toolProtocol: normalizeCloudToolProtocol(server.toolProtocol),
      auth: normalizeCloudAuth(server.auth, normalizeCloudProtocol(server.protocol)),
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
    canEditCloudDraftServer &&
    String(cloudDraftServer.name || "").trim() &&
    (cloudUsesOAuth || String(cloudDraftServer.endpoint || "").trim()),
  );

  const selectCloudServer = useCallback((serverId) => {
    const targetServer = cloudServers.find((server) => server.id === serverId);
    if (!targetServer) return;
    const previousServerId = cloudDraftServer?.id;
    if (previousServerId && previousServerId !== serverId) {
      clearOpenAiProbeCache(previousServerId);
    }
    if (!isModelRuntimeLocked) {
      setConfig((prev) => {
        const state = normalizeCloudServerState({
          cloud: prev.cloud,
          cloudServers: prev.cloudServers,
          activeCloudServerId: prev.activeCloudServerId,
        });
        return commitCloudServers(state.cloudServers, serverId, prev);
      });
    }
    setCloudDraftServer({ ...targetServer });
    setCloudDraftMode("saved");
    setCloudFetchMsg(null);
    setCloudProbeMsg(null);
    setCloudSaveMsg(null);
    setCloudAuthMsg(null);
    setCloudAuthSession(null);
    setCloudConnectionStatus(null);
    setCloudModelInputMode((cloudModelsByServer[serverId] || []).length > 0 ? "select" : "manual");
  }, [clearOpenAiProbeCache, cloudDraftServer?.id, cloudModelsByServer, cloudServers, commitCloudServers, isModelRuntimeLocked, setConfig]);

  const addCloudServer = useCallback(() => {
    const nextDraft = makeBlankCloudServerDraft();
    setCloudDraftServer(nextDraft);
    setCloudDraftMode("new");
    setCloudFetchMsg(null);
    setCloudProbeMsg(null);
    setCloudSaveMsg(null);
    setCloudAuthMsg(null);
    setCloudAuthSession(null);
    setCloudConnectionStatus(null);
    setCloudModelInputMode("manual");
  }, [makeBlankCloudServerDraft]);

  const saveCloudServer = useCallback(() => {
    if (!cloudDraftServer) return;
    if (!canEditCloudDraftServer) {
      setCloudSaveMsg({ text: modelRuntimeLockText, type: "error" });
      return;
    }
    const name = String(cloudDraftServer.name || "").trim();
    const endpoint = String(cloudDraftServer.endpoint || "").trim();
    if (!name || (!cloudUsesOAuth && !endpoint)) {
      setCloudSaveMsg({ text: copy.cloudSaveRequired, type: "error" });
      return;
    }
    persistCloudServer({ ...cloudDraftServer, name, endpoint });
    setCloudFetchMsg(null);
    setCloudProbeMsg(null);
    setCloudAuthMsg(null);
    setCloudAuthSession(null);
    setCloudConnectionStatus(null);
    setCloudSaveMsg({ text: copy.cloudSaved, type: "success" });
  }, [canEditCloudDraftServer, cloudDraftServer, cloudUsesOAuth, copy, modelRuntimeLockText, persistCloudServer]);

  const removeCloudServer = useCallback((serverId) => {
    if (isModelRuntimeLocked && (serverId === activeCloudServerId || serverId === lockedCloudServerId)) {
      setCloudSaveMsg({ text: modelRuntimeLockText, type: "error" });
      return;
    }
    if (cloudDraftMode === "new" && cloudDraftServer?.id === serverId) {
      setCloudDraftServer(savedActiveCloudServer ? { ...savedActiveCloudServer } : null);
      setCloudDraftMode(savedActiveCloudServer ? "saved" : null);
      setCloudFetchMsg(null);
      setCloudProbeMsg(null);
      setCloudSaveMsg(null);
      setCloudAuthMsg(null);
      setCloudAuthSession(null);
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
    clearOpenAiProbeCache(serverId);
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
    setCloudAuthMsg(null);
    setCloudAuthSession(null);
    setCloudConnectionStatus(null);
    setCloudSaveMsg(null);
  }, [activeCloudServerId, clearOpenAiProbeCache, cloudDraftMode, cloudDraftServer, cloudModelsByServer, cloudServers, commitCloudServers, isModelRuntimeLocked, lockedCloudServerId, modelRuntimeLockText, savedActiveCloudServer, setConfig]);

  const handleCloudProtocolChange = (e) => {
    if (!cloudDraftServer || !canEditCloudDraftServer) return;
    const nextProtocol = normalizeCloudProtocol(e.target.value);
    const nextEndpoint = defaultCloudEndpointForProtocol(nextProtocol);
    const currentEndpoint = draftCloudConfig.endpoint || "";
    const shouldReplaceEndpoint = shouldReplaceCloudEndpointForProtocol(currentEndpoint, nextProtocol);

    updateCloudDraftServer({
      protocol: nextProtocol,
      apiFormat: nextProtocol === "anthropic" ? "chat_completions" : normalizeCloudApiFormat(draftCloudConfig.apiFormat),
      provider: nextProtocol === "anthropic" ? "Anthropic" : nextProtocol === "gemini" ? "Gemini" : "OpenAI",
      endpoint: shouldReplaceEndpoint ? nextEndpoint : currentEndpoint,
      model: "",
      auth: createDefaultCloudAuth("api_key"),
    }, { clearModels: true });
    setCloudAuthMsg(null);
    setCloudAuthSession(null);
    setCloudFetchMsg(null);
    setCloudProbeMsg(null);
    setCloudConnectionStatus(null);
    clearOpenAiProbeCache(cloudDraftServer.id);
  };

  const handleCloudApiFormatChange = (e) => {
    if (cloudApiFormatLockedByOAuth || !canEditCloudDraftServer) return;
    const nextApiFormat = resolveEffectiveCloudApiFormat({
      protocol: cloudProtocol,
      apiFormat: e.target.value,
      authMode: cloudAuthMode,
    });
    updateCloudDraftServer({ apiFormat: nextApiFormat });
    setCloudProbeMsg(null);
    setCloudConnectionStatus(null);
  };

  const handleCloudAuthModeChange = useCallback((mode) => {
    if (!cloudDraftServer || !canEditCloudDraftServer) return;
    const nextMode = normalizeCloudAuthMode(mode);
    if (!cloudExperimentalLoginEnabled && nextMode !== "api_key") return;
    const protocolPatch = nextMode === "gemini_google_oauth"
      ? {
          protocol: "gemini",
          provider: "Gemini",
          endpoint: "",
        }
      : nextMode === "openai_chatgpt_oauth"
        ? {
            protocol: "openai",
            provider: "OpenAI",
            apiFormat: "responses",
            endpoint: defaultCloudEndpointForProtocol("openai"),
          }
        : {};
    updateCloudDraftServer({
      ...protocolPatch,
      auth: createDefaultCloudAuth(nextMode),
      apiKey: nextMode === "api_key" ? draftCloudConfig.apiKey || "" : "",
    }, { clearModels: true });
    if (nextMode !== "openai_chatgpt_oauth") {
      clearOpenAiProbeCache(cloudDraftServer.id);
    }
    setCloudAuthMsg(null);
    setCloudAuthSession(null);
    setCloudProbeMsg(null);
    setCloudConnectionStatus(null);
  }, [canEditCloudDraftServer, clearOpenAiProbeCache, cloudDraftServer, cloudExperimentalLoginEnabled, draftCloudConfig.apiKey, updateCloudDraftServer]);

  const updateCloudDraftAuth = useCallback((patch) => {
    if (!canEditCloudDraftServer) return;
    const nextAuth = normalizeCloudAuth({
      ...cloudAuth,
      ...patch,
    }, normalizeCloudProtocol(cloudDraftServer?.protocol));
    updateCloudDraftServer({ auth: nextAuth }, { clearModels: true });
    setCloudConnectionStatus(null);
  }, [canEditCloudDraftServer, cloudAuth, cloudDraftServer?.protocol, updateCloudDraftServer]);

  const finishCloudAuthSession = useCallback(async (session) => {
    if (!session || !cloudDraftServer) return null;
    const status = await invoke<any>("cloud_auth_finish", {
      sessionId: session.sessionId,
      serverId: cloudDraftServer.id,
    });
    if (status?.status === "connected") {
      updateCloudDraftAuth({
        mode: normalizeCloudAuthMode(status.mode ?? cloudAuthMode),
        status: "connected",
        accountId: status.accountId,
        email: status.email,
        tokenRef: status.tokenRef || cloudDraftServer.id,
        expiresAt: status.expiresAt,
        storage: status.storage,
        message: status.message,
        projectId: status.projectId,
        tier: status.tier,
        onboarded: status.onboarded,
        codeAssistMessage: status.codeAssistMessage,
      });
      setCloudAuthSession(null);
      setCloudAuthMsg({
        text: `${copy.authConnected}${status.email ? ` · ${status.email}` : ""}`,
        type: "success",
      });
      return status;
    }
    if (status?.status === "error") {
      setCloudAuthMsg({ text: status.message || copy.authFinishFailed("unknown"), type: "error" });
      return status;
    }
    setCloudAuthMsg({ text: copy.authPending, type: "warning" });
    return status;
  }, [cloudAuthMode, cloudDraftServer, copy, updateCloudDraftAuth]);

  const beginCloudAuth = useCallback(async () => {
    if (!canEditCloudDraftServer) return;
    if (!cloudExperimentalLoginEnabled || !cloudDraftServer || cloudAuthMode === "api_key" || cloudAuthBusy) return;
    setCloudAuthBusy(true);
    setCloudAuthMsg(null);
    setCloudAuthSession(null);
    try {
      const session = await invoke<any>("cloud_auth_begin", {
        provider: cloudProtocol === "gemini" ? "gemini" : "openai",
        mode: cloudAuthMode,
        serverId: cloudDraftServer.id,
      });
      setCloudAuthSession(session);
      setCloudAuthMsg({
        text: session.browserOpened === false ? copy.authBrowserFallback : copy.authPending,
        type: session.browserOpened === false ? "warning" : "success",
      });

      let completed = false;
      for (let attempt = 0; attempt < 120; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        const status = await finishCloudAuthSession(session);
        if (status?.status === "connected" || status?.status === "error") {
          completed = true;
          break;
        }
      }
      if (!completed) {
        setCloudAuthMsg({ text: copy.authPending, type: "warning" });
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      setCloudAuthMsg({ text: copy.authStartFailed(errMsg), type: "error" });
    } finally {
      setCloudAuthBusy(false);
    }
  }, [canEditCloudDraftServer, cloudAuthBusy, cloudAuthMode, cloudDraftServer, cloudExperimentalLoginEnabled, cloudProtocol, copy, finishCloudAuthSession]);

  const logoutCloudAuth = useCallback(async () => {
    if (!canEditCloudDraftServer) return;
    if (!cloudExperimentalLoginEnabled || !cloudDraftServer || cloudAuthMode === "api_key") return;
    setCloudAuthBusy(true);
    try {
      await invoke<any>("cloud_auth_logout", { serverId: cloudAuth.tokenRef || cloudDraftServer.id });
      updateCloudDraftAuth({ mode: cloudAuthMode, status: "disconnected", tokenRef: undefined, accountId: undefined, email: undefined, expiresAt: undefined, storage: undefined, message: undefined });
      clearOpenAiProbeCache(cloudDraftServer.id);
      setCloudAuthSession(null);
      setCloudAuthMsg({ text: copy.authDisconnected, type: "success" });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      setCloudAuthMsg({ text: copy.authLogoutFailed(errMsg), type: "error" });
    } finally {
      setCloudAuthBusy(false);
    }
  }, [canEditCloudDraftServer, clearOpenAiProbeCache, cloudAuth.tokenRef, cloudAuthMode, cloudDraftServer, cloudExperimentalLoginEnabled, copy, updateCloudDraftAuth]);

  const refreshCloudModels = useCallback(async (serverOverride = null) => {
    if (isFetchingCloudModels) return;
    const targetServer = serverOverride || cloudDraftServer;
    if (!targetServer) {
      setCloudFetchMsg({ text: copy.cloudSelectServerFirst, type: "error" });
      return;
    }
    if (isModelRuntimeLocked && lockedCloudServerId && targetServer.id === lockedCloudServerId) {
      setCloudFetchMsg({ text: modelRuntimeLockText, type: "error" });
      return;
    }
    const targetServerId = targetServer.id;
    const targetProtocol = normalizeCloudProtocol(targetServer.protocol);
    const targetAuth = cloudExperimentalLoginEnabled
      ? normalizeCloudAuth(targetServer.auth, targetProtocol)
      : createDefaultCloudAuth("api_key");
    const targetAuthMode = normalizeCloudAuthMode(targetAuth.mode);
    setIsFetchingCloudModels(true);
    setCloudFetchMsg(null);

    try {
      const endpoint = resolveCloudRuntimeEndpoint(targetServer, targetProtocol, targetAuthMode);
      if (!endpoint && targetAuthMode !== "gemini_google_oauth") {
        setCloudFetchMsg({ text: copy.cloudEndpointRequired, type: "error" });
        return;
      }
      const targetServerForRuntime = { ...targetServer, endpoint };

      if (targetAuthMode === "openai_chatgpt_oauth") {
        const models = [...OPENAI_CHATGPT_EXPERIMENTAL_MODELS];
        let selectedModel = models.includes(targetServer.model) ? targetServer.model : models[0];
        const canProbe = Boolean(targetAuth.tokenRef && String(targetAuth.tokenRef).trim());
        let probeSucceeded = false;
        if (canProbe) {
          const probeUrl = buildCloudMessagesApiUrl(endpoint, "openai", "responses");
          const probeHeaders = buildCloudHeaders("openai", "", true, targetServer.customHeaders, targetAuthMode);
          const probeMessages = [{ role: "user", content: language === "en" ? "Hello, please reply with only ok" : "你好，请只回复 ok" }];
          const probeModels = Array.from(new Set([
            cloudOpenAiLastGoodModelByServer[targetServerId] || "",
            String(targetServer.model || "").trim(),
            ...models,
          ].filter(Boolean))).slice(0, 3);
          probeLoop:
          for (const probeModel of probeModels) {
            const probeCandidates = buildOpenAiResponsesProbeRequestCandidates({
              messages: probeMessages,
              model: probeModel,
              includeAdvanced: false,
              authMode: targetAuthMode,
            });
            for (const candidate of probeCandidates) {
              try {
                await invoke<string>("proxy_request", {
                  url: probeUrl,
                  method: "POST",
                  headers: probeHeaders,
                  body: JSON.stringify(ensureOpenAiChatGptCodexRequestBody(candidate.body)),
                  authMode: targetAuthMode,
                  tokenRef: targetAuth.tokenRef,
                });
                selectedModel = probeModel;
                probeSucceeded = true;
                setCloudOpenAiLastGoodModelByServer((prev) => ({ ...prev, [targetServerId]: probeModel }));
                break probeLoop;
              } catch (probeErr) {
                const errMsg = probeErr instanceof Error ? probeErr.message : String(probeErr);
                if (!isProviderCompatibilityErrorMessage(errMsg) && !isRetryableCloudErrorMessage(errMsg)) {
                  break;
                }
              }
            }
          }
        }
        setCloudModelsByServer((prev) => ({ ...prev, [targetServerId]: models }));
        setCloudModelInputMode("select");
        confirmCloudModelSelection(selectedModel, targetServerForRuntime);
        setCloudFetchMsg(canProbe && !probeSucceeded
          ? { text: copy.cloudOpenAiProbeFallbackWarning(selectedModel), type: "warning" }
          : { text: copy.cloudModelsPulled(models.length, selectedModel), type: "success" });
        return;
      }

      if (targetAuthMode === "gemini_google_oauth") {
        const models = [...GEMINI_EXPERIMENTAL_MODELS];
        const selectedModel = models.includes(targetServer.model) ? targetServer.model : models[0];
        setCloudModelsByServer((prev) => ({ ...prev, [targetServerId]: models }));
        setCloudModelInputMode("select");
        confirmCloudModelSelection(selectedModel, targetServerForRuntime);
        setCloudFetchMsg({ text: copy.cloudModelsPulled(models.length, selectedModel), type: "success" });
        return;
      }

      const candidates = buildCloudModelListCandidates(endpoint, targetProtocol);
      const headers = buildCloudHeaders(targetProtocol, targetServer.apiKey || "", false, targetServer.customHeaders, targetAuthMode);

      for (const url of candidates) {
        try {
          const body = await invoke<string>("proxy_request", {
            url,
            method: "GET",
            headers,
            body: null,
            authMode: targetAuthMode,
            tokenRef: targetAuth.tokenRef,
          });
          const models = extractCloudModelIds(JSON.parse(body));
          if (models.length === 0) continue;

          const latestServer = cloudDraftServerRef.current;
          const isStaleResult = !latestServer
            || latestServer.id !== targetServerId
            || normalizeCloudProtocol(latestServer.protocol) !== targetProtocol
            || latestServer.endpoint !== targetServer.endpoint
            || latestServer.apiKey !== targetServer.apiKey
            || latestServer.customHeaders !== targetServer.customHeaders
            || normalizeCloudAuthMode(latestServer.auth?.mode) !== targetAuthMode
            || String(latestServer.auth?.tokenRef || "") !== String(targetAuth.tokenRef || "");
          if (isStaleResult) return;

          const selectedModel = models.includes(targetServer.model) ? targetServer.model : models[0];
          setCloudModelsByServer((prev) => ({ ...prev, [targetServerId]: models }));
          setCloudModelInputMode("select");
          confirmCloudModelSelection(selectedModel, targetServerForRuntime);
          setCloudFetchMsg({ text: copy.cloudModelsPulled(models.length, selectedModel), type: "success" });
          return;
        } catch {
          // Try next candidate URL
        }
      }

      setCloudModelsByServer((prev) => ({ ...prev, [targetServerId]: [] }));
      setCloudFetchMsg({ text: copy.cloudNoModels, type: "error" });
    } catch (err) {
      setCloudModelsByServer((prev) => ({ ...prev, [targetServerId]: [] }));
      const friendlyError = buildCloudAuthFriendlyError({
        protocol: targetProtocol,
        authMode: targetAuthMode,
        error: err instanceof Error ? err.message : String(err),
        language,
      });
      setCloudFetchMsg({ text: copy.cloudConnectionFailed(friendlyError), type: "error" });
    } finally {
      setIsFetchingCloudModels(false);
    }
  }, [cloudDraftServer, cloudExperimentalLoginEnabled, cloudOpenAiLastGoodModelByServer, confirmCloudModelSelection, copy, isFetchingCloudModels, isModelRuntimeLocked, language, lockedCloudServerId, modelRuntimeLockText]);

  const testCloudConnection = useCallback(async () => {
    if (isTestingCloudConnection) return;
    if (isLockedCloudDraftServer) {
      setCloudProbeMsg({ text: modelRuntimeLockText, type: "error" });
      return;
    }

    const endpoint = resolveCloudRuntimeEndpoint(draftCloudConfig, cloudProtocol, cloudAuthMode);
    const testModel = draftCloudConfig.model?.trim() || cloudAvailableModels[0] || "";
    const targetServer = cloudDraftServer ? {
      ...cloudDraftServer,
      apiFormat: cloudApiFormat,
      endpoint,
      model: testModel,
      protocol: cloudProtocol,
      toolProtocol: normalizeCloudToolProtocol(draftCloudConfig.toolProtocol),
      auth: cloudRuntimeAuth,
    } : null;
    if (!endpoint && cloudAuthMode !== "gemini_google_oauth") {
      setCloudProbeMsg({ text: copy.cloudEndpointRequired, type: "error" });
      return;
    }
    if (!testModel) {
      setCloudProbeMsg({ text: copy.cloudModelRequired, type: "error" });
      return;
    }

    setIsTestingCloudConnection(true);
    setCloudProbeMsg(null);
    setCloudConnectionStatus(null);

    try {
      const headers = buildCloudHeaders(cloudProtocol, cloudUsesOAuth ? "" : draftCloudConfig.apiKey || "", true, draftCloudConfig.customHeaders, cloudAuthMode);
      let effectiveApiFormat = cloudApiFormat;
      let payload: unknown = null;
      let effectiveTestModel = testModel;
      let successfulResponsesMode: string | null = null;
      const probeMessages = [{ role: "user", content: language === "en" ? "Hello, please reply with only ok" : "你好，请只回复 ok" }];
      const normalizeProbePayload = (raw: string) => {
        const contentType = (raw.match(/^__CONTENT_TYPE__:(.*)\n/) || [])[1]?.trim() || "";
        if (contentType.includes("text/event-stream")) {
          return { output_text: parseOpenAiResponsesSseText(raw.replace(/^__CONTENT_TYPE__:.*\n/, "")) };
        }
        return JSON.parse(raw);
      };

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
              authMode: cloudAuthMode,
              tokenRef: cloudUsesOAuth ? (cloudRuntimeAuth.tokenRef || cloudDraftServer?.id) : undefined,
            });
            return normalizeProbePayload(raw);
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
          authMode: cloudAuthMode,
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
            const body = cloudAuthMode === "openai_chatgpt_oauth"
              ? ensureOpenAiChatGptCodexRequestBody(candidate.body)
              : candidate.body;
            return {
              payload: await sendJsonProbe(url, body, includeAdvanced ? "advanced" : "base", candidate.mode),
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
        const openAiProbeFormats = cloudAuthMode === "openai_chatgpt_oauth"
          ? ["responses"]
          : [cloudApiFormat, cloudApiFormat === "responses" ? "chat_completions" : "responses"];
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
        }), "base", "anthropic");
      } else if (cloudProtocol === "gemini") {
        const geminiModels = cloudAuthMode === "gemini_google_oauth"
          ? Array.from(new Set([testModel, "gemini-2.5-pro", "gemini-2.5-flash"].filter(Boolean)))
          : [testModel];
        let lastGeminiError: unknown = null;
        for (const model of geminiModels) {
          try {
            const request = buildGeminiRequestForAuthMode(endpoint, {
              messages: probeMessages,
              model,
              maxTokens: 32,
            }, cloudAuthMode);
            payload = await sendJsonProbe(request.url, request.body, "base", request.responseMode === "code_assist" ? "gemini_code_assist" : "gemini");
            effectiveTestModel = model;
            break;
          } catch (err) {
            lastGeminiError = err;
            const errMsg = err instanceof Error ? err.message : String(err);
            if (cloudAuthMode !== "gemini_google_oauth" || !errMsg.includes("500")) throw err;
          }
        }
        if (payload == null && lastGeminiError) throw lastGeminiError;
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
        confirmCloudModelSelection(effectiveTestModel, {
          ...(targetServer || cloudDraftServer),
          apiFormat: effectiveApiFormat,
          model: effectiveTestModel,
        });
      }

      const reply = cloudProtocol === "anthropic"
        ? extractAnthropicResponseText(payload).trim()
        : cloudProtocol === "gemini"
          ? extractGeminiResponseText(payload).trim()
          : extractOpenAiResponseText(payload, effectiveApiFormat).trim();
      const switchedText = cloudProtocol === "openai" && effectiveApiFormat !== cloudApiFormat
        ? copy.cloudAutoSwitch(effectiveApiFormat === "responses" ? "Responses API" : "Chat Completions")
        : "";
      const statusFingerprint = buildCloudConnectionFingerprint({
        ...(targetServer || draftCloudConfig),
        apiFormat: effectiveApiFormat,
        model: effectiveTestModel,
      }, effectiveApiFormat, effectiveTestModel);

      setCloudConnectionStatus({
        fingerprint: statusFingerprint,
        model: effectiveTestModel,
        text: copy.cloudConnected(effectiveTestModel, switchedText),
      });
      if (cloudProtocol === "openai" && cloudAuthMode === "openai_chatgpt_oauth" && cloudDraftServer?.id) {
        setCloudOpenAiLastGoodModelByServer((prev) => ({ ...prev, [cloudDraftServer.id]: effectiveTestModel }));
      }

      setCloudProbeMsg({
        text: reply
          ? copy.cloudBasicSuccessWithReply(effectiveTestModel, reply.slice(0, 120), switchedText)
          : copy.cloudBasicSuccess(effectiveTestModel, switchedText),
        type: "success",
      });

      const shouldRunAdvancedProbe = cloudProtocol === "openai"
        && effectiveApiFormat === "responses"
        && cloudAuthMode !== "openai_chatgpt_oauth"
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
            setCloudProbeMsg({ text: copy.cloudAdvancedSuccess, type: "success" });
          }
        } catch (advancedErr) {
          if (!cloudDraftServer || isSameCloudConnectionTarget(cloudDraftServerRef.current, {
            ...targetServer,
            apiFormat: effectiveApiFormat,
          })) {
            const errMsg = advancedErr instanceof Error ? advancedErr.message : String(advancedErr);
            setCloudProbeMsg({
              text: copy.cloudAdvancedWarning(errMsg),
              type: "warning",
            });
          }
        }
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      const friendlyError = buildCloudAuthFriendlyError({
        protocol: cloudProtocol,
        authMode: cloudAuthMode,
        error: errMsg,
        language,
      });
      const protocolHint = cloudProtocol === "anthropic" && errMsg.includes("/v1/messages")
        ? copy.cloudProtocolHint
        : "";
      const retryHint = isRetryableCloudErrorMessage(errMsg)
        ? copy.cloudRetryHint
        : "";
      setCloudProbeMsg({ text: copy.cloudTestFailed(friendlyError, protocolHint, retryHint), type: "error" });
    } finally {
      setIsTestingCloudConnection(false);
    }
  }, [
    cloudApiFormat,
    cloudAvailableModels,
    cloudAuthMode,
    cloudDraftServer,
    cloudRuntimeAuth,
    cloudProtocol,
    cloudUsesOAuth,
    confirmCloudModelSelection,
    copy,
    draftCloudConfig.apiKey,
    draftCloudConfig.customHeaders,
    draftCloudConfig.disableResponseStorage,
    draftCloudConfig.endpoint,
    draftCloudConfig.model,
    draftCloudConfig.reasoningEffort,
    draftCloudConfig.toolProtocol,
    isLockedCloudDraftServer,
    isTestingCloudConnection,
    language,
    modelRuntimeLockText,
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
  const compressionLabel = contextRatio < 0.3 ? copy.compressionLow : contextRatio < 0.7 ? copy.compressionBalanced : copy.compressionLong;
  const compressionHint = contextRatio < 0.3
    ? copy.compressionLowHint
    : contextRatio < 0.7
      ? copy.compressionBalancedHint
      : copy.compressionLongHint;
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
        <span style={{ color: contextRatio < 0.3 ? '#60a5fa' : '#3f3f46' }}>{copy.zoneLow}</span>
        <span style={{ color: contextRatio >= 0.3 && contextRatio < 0.7 ? '#a78bfa' : '#3f3f46' }}>{copy.zoneBalanced}</span>
        <span style={{ color: contextRatio >= 0.7 ? '#f97316' : '#3f3f46' }}>{copy.zoneLong}</span>
      </div>

      {/* Stats panel */}
      <div className="bg-[#000000] border border-[#27272a] rounded-lg p-4 shadow-inner">
        <div className="flex items-center justify-between gap-4">
          {/* Left: Max Tokens */}
          <div className="flex-1">
            <p className="text-[10px] text-[#71717a] uppercase tracking-wider mb-1">{copy.contextTriggerThreshold}</p>
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
            <p className="text-[10px] text-[#71717a] uppercase tracking-wider mb-1">{copy.estimatedContextVram}</p>
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
              {copy.currentLimit(contextMax.toLocaleString())}
            </p>
          </div>
        </div>

        {/* Device memory bar */}
        {systemMemory && (
          <div className="mt-3 pt-3 border-t border-[#18181b] flex items-center gap-2.5">
            <span className="text-[10px] text-[#3f3f46]">🖥</span>
            <div className="flex-1">
              <div className="flex items-center justify-between mb-1">
                <span className="text-[10px] text-[#71717a]">{copy.deviceMemory}</span>
                <span className="text-[10px] font-mono text-[#a1a1aa]">
                  {systemMemory.available_gb} / {systemMemory.total_gb} GB {copy.available}
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
              {copy.maxBar(maxVramInfo.text, !!safeKvCacheGb)}
            </p>
          </div>
        </div>
        )}
      </div>

      <p className="text-[11px] text-[#71717a] italic">{t.vramNote}</p>

      {/* Tip */}
      <div className="p-3 bg-[#000000] border border-[#27272a] rounded-md">
        <p className="text-[11px] text-[#71717a] leading-relaxed">
          <span className="text-[#a1a1aa]">{copy.tipLabel}</span>：{copy.contextTip}
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
          <button data-testid="settings-close" onClick={handleCancelSettings} className="text-[#a1a1aa] hover:text-white transition-colors"><IconClose className="w-4 h-4" /></button>
        </div>

        <div className="flex min-h-0 flex-1">
          <div className="w-52 shrink-0 overflow-y-auto border-r border-[#27272a] bg-[#000000] p-2 flex flex-col gap-1">
            <button data-testid="settings-tab-general" onClick={() => setSettingsTab('general')} className={`text-left px-4 py-2.5 text-[13px] font-medium rounded-md transition-colors ${settingsTab === 'general' ? 'theme-bg shadow-sm' : 'text-[#a1a1aa] hover:text-[#e4e4e7] hover:bg-[#18181b]'}`}>{t.general}</button>
            <button data-testid="settings-tab-local" onClick={() => setSettingsTab('local')} className={`text-left px-4 py-2.5 text-[13px] font-medium rounded-md transition-colors ${settingsTab === 'local' ? 'theme-bg shadow-sm' : 'text-[#a1a1aa] hover:text-[#e4e4e7] hover:bg-[#18181b]'}`}>{t.localSetup}</button>
            <button data-testid="settings-tab-cloud" onClick={() => setSettingsTab('cloud')} className={`text-left px-4 py-2.5 text-[13px] font-medium rounded-md transition-colors ${settingsTab === 'cloud' ? 'theme-bg shadow-sm' : 'text-[#a1a1aa] hover:text-[#e4e4e7] hover:bg-[#18181b]'}`}>{t.cloudSetup}</button>
            <button data-testid="settings-tab-context" onClick={() => setSettingsTab('context')} className={`text-left px-4 py-2.5 text-[13px] font-medium rounded-md transition-colors ${settingsTab === 'context' ? 'theme-bg shadow-sm' : 'text-[#a1a1aa] hover:text-[#e4e4e7] hover:bg-[#18181b]'}`}>{t.contextSetup}</button>
            <button data-testid="settings-tab-mcp" onClick={() => setSettingsTab('mcp')} className={`text-left px-4 py-2.5 text-[13px] font-medium rounded-md transition-colors ${settingsTab === 'mcp' ? 'theme-bg shadow-sm' : 'text-[#a1a1aa] hover:text-[#e4e4e7] hover:bg-[#18181b]'}`}>{copy.mcpServerTitle}</button>
            <button data-testid="settings-tab-im" onClick={() => setSettingsTab('im')} className={`text-left px-4 py-2.5 text-[13px] font-medium rounded-md transition-colors ${settingsTab === 'im' ? 'theme-bg shadow-sm' : 'text-[#a1a1aa] hover:text-[#e4e4e7] hover:bg-[#18181b]'}`}>{t.imAdapters}</button>
            <button data-testid="settings-tab-data" onClick={() => setSettingsTab('data')} className={`text-left px-4 py-2.5 text-[13px] font-medium rounded-md transition-colors ${settingsTab === 'data' ? 'theme-bg shadow-sm' : 'text-[#a1a1aa] hover:text-[#e4e4e7] hover:bg-[#18181b]'}`}>{t.dataManagement}</button>
            <button data-testid="settings-tab-debug" onClick={() => setSettingsTab('debug')} className={`text-left px-4 py-2.5 text-[13px] font-medium rounded-md transition-colors ${settingsTab === 'debug' ? 'theme-bg shadow-sm' : 'text-[#a1a1aa] hover:text-[#e4e4e7] hover:bg-[#18181b]'}`}>{t.debugLog}</button>
            <button data-testid="settings-tab-about" onClick={() => setSettingsTab('about')} className={`mt-auto text-left px-4 py-2.5 text-[13px] font-medium rounded-md transition-colors ${settingsTab === 'about' ? 'theme-bg shadow-sm' : 'text-[#a1a1aa] hover:text-[#e4e4e7] hover:bg-[#18181b]'}`}>{t.about}</button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto bg-[#09090b] p-6 pb-8">

            {/* GENERAL SETTINGS + THEME */}
            {settingsTab === 'general' && (
              <div className="space-y-5">
                <div className="flex items-center justify-between"><h3 className="text-[13px] font-bold text-[#a1a1aa] uppercase tracking-wider">{t.general}</h3></div>
                <div className={settingsSectionRowClass}>
                  <div>
                    <label className="block text-[13px] font-bold text-[#e4e4e7]">{copy.displayLanguage}</label>
                  </div>
                  <div className={settingsControlColumnClass}>
                    <select
                      value={config.language}
                      onChange={(e) =>
                        setConfig({
                          ...config,
                          language: e.target.value,
                          responseLanguagePolicy: "prefer_system_language_with_explicit_switch",
                        })
                      }
                      className={settingsSelectClass}
                    >
                      <option value="en">English</option><option value="zh">简体中文</option>
                    </select>
                  </div>
                </div>

                <div className={`${settingsSectionRowClass} border-t border-[#27272a] pt-5`}>
                  <div>
                    <label className="block text-[13px] font-bold text-[#e4e4e7]">{copy.responseLanguagePolicy}</label>
                    <p className="mt-1.5 text-[12px] leading-relaxed text-[#a1a1aa]">{copy.responseLanguagePolicyDesc}</p>
                  </div>
                  <div className={settingsControlColumnClass}>
                    <select
                      value={config.responseLanguagePolicy || "follow_input_language"}
                      onChange={(e) =>
                        setConfig({
                          ...config,
                          responseLanguagePolicy:
                            e.target.value === "prefer_system_language_with_explicit_switch"
                              ? "prefer_system_language_with_explicit_switch"
                              : "follow_input_language",
                        })
                      }
                      className={settingsSelectClass}
                    >
                      <option value="follow_input_language">{copy.responseLanguageFollowInput}</option>
                      <option value="prefer_system_language_with_explicit_switch">{copy.responseLanguageSystemPreferred}</option>
                    </select>
                  </div>
                </div>

                {/* THEME COLOR PICKER */}
                <div className={`${settingsSectionRowClass} border-t border-[#27272a] pt-5`}>
                  <div>
                    <label className="block text-[13px] font-bold text-[#e4e4e7]">{t.themeColor}</label>
                    <p className="mt-1.5 text-[12px] leading-relaxed text-[#a1a1aa]">{t.themeDesc}</p>
                  </div>
                  <div className={`${settingsControlColumnClass} flex flex-wrap gap-3 lg:justify-end`}>
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
                <div className={`${settingsSectionRowClass} border-t border-[#27272a] pt-5`}>
                  <div>
                    <label className="block text-[13px] font-bold text-[#e4e4e7]">{t.themeMode}</label>
                  </div>
                  <div className={`${settingsControlColumnClass} flex flex-wrap items-center gap-2 lg:justify-end`}>
                    <button
                      onClick={() => setConfig({ ...config, themeMode: "dark" })}
                      aria-pressed={config.themeMode === "dark"}
                      className={settingsOptionButtonClass(config.themeMode === "dark", "flex items-center gap-2 rounded-md px-4 py-2 text-[12px] font-bold")}
                    >
                      <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" /></svg>
                      {t.themeModeDark}
                    </button>
                    <button
                      onClick={() => setConfig({ ...config, themeMode: "black" })}
                      aria-pressed={config.themeMode === "black"}
                      className={settingsOptionButtonClass(config.themeMode === "black", "flex items-center gap-2 rounded-md px-4 py-2 text-[12px] font-bold")}
                    >
                      <span className="h-3.5 w-3.5 rounded-full border border-current bg-black shadow-[inset_0_0_0_2px_rgba(255,255,255,0.08)]" />
                      {t.themeModeBlack}
                    </button>
                    <button
                      onClick={() => setConfig({ ...config, themeMode: "light" })}
                      aria-pressed={config.themeMode === "light"}
                      className={settingsOptionButtonClass(config.themeMode === "light", "flex items-center gap-2 rounded-md px-4 py-2 text-[12px] font-bold")}
                    >
                      <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="5" /><line x1="12" y1="1" x2="12" y2="3" /><line x1="12" y1="21" x2="12" y2="23" /><line x1="4.22" y1="4.22" x2="5.64" y2="5.64" /><line x1="18.36" y1="18.36" x2="19.78" y2="19.78" /><line x1="1" y1="12" x2="3" y2="12" /><line x1="21" y1="12" x2="23" y2="12" /><line x1="4.22" y1="19.78" x2="5.64" y2="18.36" /><line x1="18.36" y1="5.64" x2="19.78" y2="4.22" /></svg>
                      {t.themeModeLight}
                    </button>
                  </div>
                </div>

                {/* CHAT FONT SIZE */}
                <div className={`${settingsSectionRowClass} border-t border-[#27272a] pt-5`}>
                  <div>
                    <label className="block text-[13px] font-bold text-[#e4e4e7]">{t.chatFontSize}</label>
                    <p className="mt-1.5 text-[12px] leading-relaxed text-[#a1a1aa]">{t.chatFontSizeDesc}</p>
                  </div>
                  <div className={settingsControlColumnClass}>
                    <div className="mb-3 flex items-center justify-end">
                      <span className="text-[12px] font-mono theme-subtle-bg px-2 py-0.5 rounded border theme-subtle-border">{config.chatFontSize ?? 13} px</span>
                    </div>
                    <input
                      data-testid="chat-font-size-slider"
                      type="range" min={10} max={20} step={1}
                      value={config.chatFontSize ?? 13}
                      onChange={(e) => setConfig({ ...config, chatFontSize: parseInt(e.target.value) })}
                      className="w-full theme-slider cursor-pointer"
                    />
                    <div className="relative mt-1 h-4 text-[11px] text-[#3f3f46] font-mono">
                      <span className="absolute left-0">10</span>
                      <span className="absolute -translate-x-1/2" style={{ left: "30%" }}>13</span>
                      <span className="absolute -translate-x-1/2" style={{ left: "60%" }}>16</span>
                      <span className="absolute right-0">20</span>
                    </div>
                  </div>
                </div>

                {/* SESSION RECORDING */}
                <div className={`${settingsSectionRowClass} border-t border-[#27272a] pt-5`}>
                  <div>
                    <span className="block text-[13px] font-bold text-[#e4e4e7]">{t.sessionRecording}</span>
                    <span className="mt-1.5 block text-[12px] leading-relaxed text-[#a1a1aa]">{t.sessionRecordingDesc}</span>
                  </div>
                  <div className={`${settingsControlColumnClass} flex items-center justify-between rounded-lg border border-[#27272a] bg-[#000000] px-4 py-3`}>
                    <span className={`min-w-0 text-[12px] font-bold ${config.sessionRecordingEnabled !== false ? "theme-text" : "text-[#a1a1aa]"}`}>
                      {config.sessionRecordingEnabled !== false ? copy.enabled : copy.disabled}
                    </span>
                    <button
                      type="button"
                      role="switch"
                      aria-checked={config.sessionRecordingEnabled !== false}
                      data-testid="session-recording-switch"
                      aria-label={t.sessionRecording}
                      onClick={() => setConfig({ ...config, sessionRecordingEnabled: !(config.sessionRecordingEnabled !== false) })}
                      className={`relative inline-flex h-6 w-11 items-center rounded-full border p-0.5 transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[#000000] ${
                        config.sessionRecordingEnabled !== false
                          ? "border-transparent shadow-[0_0_12px_var(--accent-subtle)]"
                          : "border-[#3f3f46] bg-[#18181b]"
                      }`}
                      style={config.sessionRecordingEnabled !== false ? { backgroundColor: "var(--accent)" } : undefined}
                    >
                      <span
                        className={`block h-5 w-5 rounded-full bg-white shadow-sm transition-transform duration-200 ${
                          config.sessionRecordingEnabled !== false ? "translate-x-5" : "translate-x-0"
                        }`}
                      />
                    </button>
                  </div>
                </div>
              </div>
            )}

            {/* ABOUT / UPDATES */}
            {settingsTab === 'about' && (
              <div className="space-y-5">
                <div>
                  <h3 className="text-[13px] font-bold text-[#a1a1aa] uppercase tracking-wider">{t.about}</h3>
                  <p className="mt-1.5 text-[12px] leading-relaxed text-[#71717a]">{copy.aboutDesc}</p>
                </div>

                <div className={settingsSectionRowClass}>
                  <div>
                    <label className="block text-[13px] font-bold text-[#e4e4e7]">{copy.appIconStyle}</label>
                  </div>
                  <div className={`${settingsControlColumnClass} space-y-2`}>
                    <div className="flex flex-wrap gap-3">
                      {appIconOptions.map((option) => {
                        const selected = draftAppIconVariant === option.value;
                        return (
                          <button
                            key={option.value}
                            type="button"
                            aria-pressed={selected}
                            aria-label={option.label}
                            title={option.label}
                            onClick={() => {
                              setDraftAppIconVariant(option.value);
                              setAppIconApplyMsg(null);
                            }}
                            className={settingsOptionButtonClass(selected, "relative flex h-[86px] w-[86px] items-center justify-center rounded-md p-2")}
                          >
                            <img
                              src={option.src}
                              alt=""
                              className="h-16 w-16 shrink-0 rounded-[14px] border border-[#3f3f46] bg-[#000000] object-cover"
                              draggable={false}
                            />
                            {selected && (
                              <span className="absolute right-1.5 top-1.5 inline-flex h-5 w-5 items-center justify-center rounded-full border border-[var(--accent-subtle-border)] bg-[#09090b] theme-text">
                                <IconCheck className="h-3.5 w-3.5" />
                              </span>
                            )}
                          </button>
                        );
                      })}
                    </div>
                    {appIconApplyMsg && (
                      <p className="text-[11.5px] leading-relaxed text-[#fbbf24]">{appIconApplyMsg.text}</p>
                    )}
                  </div>
                </div>

                <div className={`${settingsSectionRowClass} border-t border-[#27272a] pt-5`}>
                  <div>
                    <label className="block text-[13px] font-bold text-[#e4e4e7]">{t.currentVersion}</label>
                    <p className="mt-1.5 text-[12px] leading-relaxed text-[#a1a1aa]">{copy.latestCheck}: {lastUpdateCheckedText}</p>
                  </div>
                  <div className={settingsControlColumnClass}>
                    <div className="rounded-md border border-[#27272a] bg-[#000000] px-3 py-2.5 font-mono text-[13px] text-[#e4e4e7]">
                      {appVersion || copy.unknownVersion}
                    </div>
                  </div>
                </div>

                <div className={`${settingsSectionRowClass} border-t border-[#27272a] pt-5`}>
                  <div>
                    <label className="block text-[13px] font-bold text-[#e4e4e7]">{t.checkForUpdates}</label>
                    <p className="mt-1.5 text-[12px] leading-relaxed text-[#a1a1aa]">{updateStatusDesc}</p>
                  </div>
                  <div className={`${settingsControlColumnClass} space-y-3`}>
                    <div className={`rounded-md border px-3 py-2.5 text-[12px] ${
                      updateStatus === "error"
                        ? "border-[#3f1f1f] bg-[#181111] text-[#fca5a5]"
                        : updateStatus === "available"
                          ? "theme-subtle-border theme-subtle-bg theme-text"
                          : "border-[#27272a] bg-[#000000] text-[#a1a1aa]"
                    }`}>
                      {updateStatusText}
                    </div>
                    {releaseNotesSummary && availableUpdateVersion && (updateStatus === "available" || updateStatus === "error") && (
                      <pre className="max-h-44 overflow-auto whitespace-pre-wrap rounded-md border border-[#27272a] bg-[#000000] p-3 text-[11px] leading-relaxed text-[#a1a1aa]">
                        {releaseNotesSummary}
                      </pre>
                    )}
                    <div className="flex flex-wrap gap-2">
                      <button
                        type="button"
                        data-testid="settings-check-update"
                        onClick={onCheckForUpdate}
                        disabled={updateBusy || !onCheckForUpdate}
                        className="rounded-md border border-[#27272a] bg-[#18181b] px-3 py-2 text-[12px] font-bold text-[#e4e4e7] transition-colors hover:border-[#3f3f46] hover:text-white disabled:cursor-wait disabled:opacity-50"
                      >
                        {updateStatus === "checking" ? t.checkingForUpdates : t.checkForUpdates}
                      </button>
                      <button
                        type="button"
                        data-testid="settings-open-github-releases"
                        aria-label={copy.openGitHubReleases}
                        title={copy.openGitHubReleases}
                        onClick={handleOpenGitHubReleases}
                        className="inline-flex h-9 w-9 items-center justify-center rounded-md border border-[#27272a] bg-[#18181b] text-[#e4e4e7] transition-colors hover:border-[#3f3f46] hover:text-white"
                      >
                        <IconGitHub className="h-4 w-4" />
                      </button>
                      {availableUpdateVersion && updateStatus !== "checking" && (
                        <button
                          type="button"
                          data-testid="settings-install-update"
                          onClick={onInstallUpdate}
                          disabled={updateBusy || !onInstallUpdate}
                          className="rounded-md border border-[var(--accent-subtle-border)] bg-[var(--accent-subtle)] px-3 py-2 text-[12px] font-bold text-white transition-colors hover:bg-[var(--accent)] disabled:cursor-wait disabled:opacity-50"
                        >
                          {t.installAndRestart}
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* LOCAL AI SETTINGS */}
            {settingsTab === 'local' && (
              <div className="space-y-6">
                <div className="flex items-center justify-between">
                  <h3 className="text-[13px] font-bold text-[#a1a1aa] uppercase tracking-wider">{t.localSetup}</h3>
                  <button
                    data-testid="local-active-profile-button"
                    onClick={() => canChangeCurrentModel && setConfig({ ...config, activeProfile: 'local' })}
                    disabled={!canChangeCurrentModel}
                    aria-pressed={config.activeProfile === 'local'}
                    title={!canChangeCurrentModel ? modelRuntimeLockText : undefined}
                    className={settingsOptionButtonClass(config.activeProfile === 'local', "rounded px-2.5 py-1.5 text-[11px] font-bold uppercase tracking-wider disabled:cursor-not-allowed disabled:opacity-45")}
                  >
                    {config.activeProfile === 'local' ? copy.activeProfile : copy.setAsActive}
                  </button>
                </div>
                {isModelRuntimeLocked && (
                  <p data-testid="model-runtime-lock-notice" className="rounded-md border border-[#3f2f1f] bg-[#18110a] px-3 py-2 text-[11.5px] text-[#fbbf24]">
                    {modelRuntimeLockText}
                  </p>
                )}
                <div>
                  <label className="block text-[13px] font-bold text-[#e4e4e7] mb-2">{copy.providerEngine}</label>
                  <select data-testid="local-provider-select" value={config.local.provider} onChange={handleProviderChange} disabled={!canChangeCurrentModel} className={settingsSelectClass}>
                    <option value="LM Studio">LM Studio</option>
                    <option value="Ollama">Ollama</option>
                    <option value="OMLX">OMLX (MLX for Mac)</option>
                  </select>
                </div>
                <div>
                  <label className="block text-[13px] font-bold text-[#e4e4e7] mb-2">{copy.apiEndpoint}</label>
                  <input data-testid="local-endpoint-input" type="text" value={config.local.endpoint} disabled={!canChangeCurrentModel} onChange={(e) => setConfig({ ...config, local: { ...config.local, endpoint: e.target.value } })} className="w-full bg-[#000000] border border-[#27272a] rounded-md p-2.5 text-[14px] text-white focus:outline-none theme-ring font-mono disabled:cursor-not-allowed disabled:opacity-60" />
                </div>
                {config.local.provider === "OMLX" && (
                  <div>
                    <label className="block text-[13px] font-bold text-[#e4e4e7] mb-2">{copy.apiKeyOptionalOmlx} <span className="text-[#71717a] font-normal">({copy.optionalOmlxAuth})</span></label>
                    <input
                      type="password"
                      value={config.local.apiKey || ""}
                      disabled={!canChangeCurrentModel}
                      onChange={(e) => setConfig({ ...config, local: { ...config.local, apiKey: e.target.value } })}
                      placeholder={copy.noAuthPlaceholder}
                      className="w-full bg-[#000000] border border-[#27272a] rounded-md p-2.5 text-[14px] text-white focus:outline-none theme-ring font-mono placeholder:text-[#3f3f46] disabled:cursor-not-allowed disabled:opacity-60"
                    />
                  </div>
                )}
                <details
                  data-testid="local-advanced-compatibility"
                  open={isLocalAdvancedOpen}
                  onToggle={(e) => setIsLocalAdvancedOpen((e.currentTarget as HTMLDetailsElement).open)}
                  className="group rounded-md border border-[#27272a] bg-[#09090b] p-3 [&>summary::-webkit-details-marker]:hidden"
                >
                  <summary style={{ listStyle: "none" }} className="flex cursor-pointer select-none items-center justify-between gap-3">
                    <span className="min-w-0">
                      <span className="block text-[13px] font-bold text-[#e4e4e7]">{copy.advancedCompatibility}</span>
                      <span className="mt-1 block text-[11.5px] text-[#71717a]">{copy.advancedCompatibilityDesc}</span>
                    </span>
                    <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-[#27272a] bg-[#000000] text-[#a1a1aa] transition-colors">
                      {isLocalAdvancedOpen ? <IconChevronUp className="h-4 w-4" /> : <IconChevronDown className="h-4 w-4" />}
                    </span>
                  </summary>
                  <div className="mt-4 space-y-4">
                    <div>
                      <label className="mb-2 block text-[13px] font-bold text-[#e4e4e7]">{copy.toolProtocol}</label>
                      <p className="mb-2 text-[11.5px] text-[#71717a]">
                        {config.local.provider === "Ollama" ? copy.localToolProtocolOllamaHint : copy.toolProtocolDesc}
                      </p>
                      <select
                        data-testid="local-tool-protocol-select"
                        value={normalizeLocalToolProtocol(config.local.toolProtocol, config.local.provider)}
                        disabled={!canChangeCurrentModel}
                        onChange={(e) => setConfig({
                          ...config,
                          local: {
                            ...config.local,
                            toolProtocol: normalizeLocalToolProtocol(e.target.value, config.local.provider),
                          },
                        })}
                        className={settingsSelectClass}
                      >
                        <option value="auto">Auto</option>
                        <option value="native">Native</option>
                        <option value="xml">{config.local.provider === "Ollama" ? "XML / Text Tools" : "XML"}</option>
                      </select>
                    </div>
                  </div>
                </details>
                {/* Auto-detected model selector */}
                <div>
                  <label className="block text-[13px] font-bold text-[#e4e4e7] mb-2">{copy.localModel}</label>
                  <div className="flex gap-2">
                    <select
                      data-testid="local-model-select"
                      value={config.local.model || ""}
                      onChange={(e) => setConfig({ ...config, local: { ...config.local, model: e.target.value } })}
                      disabled={isFetchingModels || !canChangeCurrentModel}
                      className={`${settingsSelectClass} min-w-0 flex-1`}
                    >
                      {isFetchingModels ? (
                        <option value="">{copy.scanningModels}</option>
                      ) : availableModels.length === 0 ? (
                        <option value="">{copy.noModels}</option>
                      ) : (
                        <>
                          <option value="">{copy.localModelUnselected}</option>
                          {availableModels.map(m => (<option key={m} value={m}>{m}</option>))}
                        </>
                      )}
                    </select>
                    <button
                      onClick={() => fetchModels()}
                      disabled={isFetchingModels || !canChangeCurrentModel}
                      className="px-3 py-2 text-[12px] font-bold bg-[#18181b] text-[#a1a1aa] hover:text-white border border-[#27272a] rounded-md transition-colors shrink-0 disabled:opacity-50"
                    >
                      {isFetchingModels ? copy.mcpScanning : copy.scanModels}
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
              language={language}
              t={t}
            />}

            {/* DATA MANAGEMENT */}
            {settingsTab === 'data' && <DataManagerPanel t={t} language={language} />}

            {/* DEBUG LOG */}
            {settingsTab === 'debug' && (
              <DebugLogPanel
                t={t}
                language={language}
                config={config}
                setConfig={setConfig}
              />
            )}

            {/* IM ADAPTER SETTINGS */}
            {settingsTab === 'im' && <FeishuAdapterPanel config={config} setConfig={setConfig} t={t} />}

            {/* CLOUDED API SETTINGS */}
            {settingsTab === 'cloud' && (
              <div className="space-y-5">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <h3 className="text-[13px] font-bold text-[#a1a1aa] uppercase tracking-wider">{t.cloudSetup}</h3>
                    <p className="mt-1 text-[11.5px] text-[#71717a]">{copy.cloudDesc}</p>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <div title={copy.cloudLabDesc} className="flex items-center gap-2 rounded-md border border-[#27272a] bg-[#000000] px-2.5 py-1.5 text-[11px] text-[#a1a1aa]">
                      <span className="font-bold uppercase tracking-wider">{copy.cloudLab}</span>
                      <span className="text-[#71717a]">{cloudExperimentalLoginEnabled ? copy.cloudLabOn : copy.cloudLabOff}</span>
                      <button
                        data-testid="cloud-lab-toggle"
                        type="button"
                        role="switch"
                        aria-checked={cloudExperimentalLoginEnabled}
                        aria-label={`${copy.cloudLab} ${cloudExperimentalLoginEnabled ? copy.cloudLabOn : copy.cloudLabOff}`}
                        disabled={!canChangeCurrentModel}
                        title={!canChangeCurrentModel ? modelRuntimeLockText : copy.cloudLabDesc}
                        onClick={() => canChangeCurrentModel && setConfig((prev) => ({ ...prev, cloudExperimentalLoginEnabled: prev.cloudExperimentalLoginEnabled !== true }))}
                        className={`relative inline-flex h-6 w-11 items-center rounded-full border p-0.5 transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[#000000] disabled:cursor-not-allowed disabled:opacity-45 ${
                          cloudExperimentalLoginEnabled ? "border-transparent shadow-[0_0_12px_var(--accent-subtle)]" : "border-[#3f3f46] bg-[#18181b]"
                        }`}
                        style={cloudExperimentalLoginEnabled ? { backgroundColor: "var(--accent)" } : undefined}
                      >
                        <span
                          className={`block h-5 w-5 rounded-full bg-white shadow-sm transition-transform duration-200 ${
                            cloudExperimentalLoginEnabled ? "translate-x-5" : "translate-x-0"
                          }`}
                        />
                      </button>
                    </div>
                    <button
                      data-testid="cloud-active-profile-button"
                      onClick={() => canChangeCurrentModel && setConfig({ ...config, activeProfile: 'cloud' })}
                      disabled={!canChangeCurrentModel}
                      aria-pressed={config.activeProfile === 'cloud'}
                      title={!canChangeCurrentModel ? modelRuntimeLockText : undefined}
                      className={settingsOptionButtonClass(config.activeProfile === 'cloud', "rounded px-2.5 py-1.5 text-[11px] font-bold uppercase tracking-wider disabled:cursor-not-allowed disabled:opacity-45")}
                    >
                      {config.activeProfile === 'cloud' ? copy.activeProfile : copy.setAsActive}
                    </button>
                  </div>
                </div>
                {isModelRuntimeLocked && (
                  <p data-testid="model-runtime-lock-notice" className="rounded-md border border-[#3f2f1f] bg-[#18110a] px-3 py-2 text-[11.5px] text-[#fbbf24]">
                    {modelRuntimeLockText}
                  </p>
                )}

                <section data-testid="cloud-model-panel" className="rounded-lg border border-[#27272a] bg-[#000000] p-4">
                  {cloudDraftServer ? (
                    <>
                      <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
                        <div className="min-w-0">
                          <label className="block text-[13px] font-bold text-[#e4e4e7]">{copy.modelName}</label>
                          <p className="mt-1 text-[11.5px] text-[#71717a]">
                            {copy.currentServer}<span className="text-[#a1a1aa]">{cloudDraftServer.name || copy.unnamedServer}</span>
                            {cloudDraftMode === "new" && <span className="ml-2 rounded border border-[#3f3f46] px-1.5 py-0.5 text-[9px] font-bold uppercase text-[#a1a1aa]">{copy.unsaved}</span>}
                          </p>
                        </div>
                        {cloudAvailableModels.length > 0 && (
                          <button
                            data-testid="cloud-model-mode-toggle"
                            onClick={() => {
                              if (!canEditCloudDraftServer) return;
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
                            disabled={!canEditCloudDraftServer}
                            className={settingsOptionButtonClass(false, "rounded px-2.5 py-1.5 text-[11px] font-bold disabled:cursor-not-allowed disabled:opacity-45")}
                          >
                            {cloudModelInputMode === "select" ? copy.manualInput : copy.dropdownSelect}
                          </button>
                        )}
                      </div>
                      <div className="flex flex-col gap-2 sm:flex-row">
                        {cloudAvailableModels.length > 0 && cloudModelInputMode === "select" ? (
                          <select
                            data-testid="cloud-model-select"
                            value={draftCloudConfig.model || ""}
                            onChange={(e) => confirmCloudModelSelection(e.target.value)}
                            disabled={isFetchingCloudModels || !canEditCloudDraftServer}
                            className={`${settingsSelectClass} min-w-0 flex-1`}
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
                            disabled={!canEditCloudDraftServer}
                            placeholder={cloudModelPlaceholder}
                            className="min-w-0 flex-1 rounded-md border border-[#27272a] bg-[#000000] p-2.5 font-mono text-[14px] text-white outline-none theme-ring placeholder:text-[#3f3f46] disabled:cursor-not-allowed disabled:opacity-60"
                          />
                        )}
                        <button
                          data-testid="cloud-model-refresh"
                          onClick={() => refreshCloudModels()}
                          disabled={isFetchingCloudModels || !canEditCloudDraftServer}
                          className="shrink-0 rounded-md border border-[#27272a] bg-[#18181b] px-3 py-2 text-[12px] font-bold text-[#a1a1aa] transition-colors hover:text-white disabled:opacity-50"
                        >{isFetchingCloudModels ? copy.refreshing : copy.refresh}</button>
                        <button
                          data-testid="cloud-model-test"
                          onClick={testCloudConnection}
                          disabled={isTestingCloudConnection || !canEditCloudDraftServer}
                          className="shrink-0 rounded-md border border-[#27272a] bg-[#18181b] px-3 py-2 text-[12px] font-bold text-[#a1a1aa] transition-colors hover:text-white disabled:opacity-50"
                        >{isTestingCloudConnection ? copy.testing : copy.test}</button>
                      </div>
                      {cloudAvailableModels.length > 0 && (
                        <p data-testid="cloud-model-fetched-count" className="mt-2 text-[11px] text-[#71717a]">{copy.fetchedModels(cloudAvailableModels.length)}</p>
                      )}
                      {activeCloudConnectionStatus && (
                        <p data-testid="cloud-model-connected-status" className="mt-2 flex items-center gap-1.5 text-[12px] font-medium text-[#86d9a3]">
                          <IconCheck className="h-3.5 w-3.5" />
                          <span>{activeCloudConnectionStatus.text}</span>
                        </p>
                      )}
                      {cloudFetchMsg && <p className={`mt-2 text-[12px] ${cloudFetchMsg.type === 'error' ? 'text-[#f48771]' : cloudFetchMsg.type === 'warning' ? 'text-[#fbbf24]' : 'text-[#86d9a3]'}`}>{cloudFetchMsg.text}</p>}
                      {cloudProbeMsg && <p className={`mt-2 text-[12px] ${cloudProbeMsg.type === 'error' ? 'text-[#f48771]' : cloudProbeMsg.type === 'warning' ? 'text-[#fbbf24]' : 'text-[#86d9a3]'}`}>{cloudProbeMsg.text}</p>}
                    </>
                  ) : (
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                      <div className="flex min-w-0 items-start gap-3">
                        <div className="flex h-9 w-9 items-center justify-center rounded-md border border-[#27272a] bg-[#09090b] text-[#71717a]">
                          <IconCloud className="h-4 w-4" />
                        </div>
                        <div className="min-w-0">
                          <p className="text-[13px] font-bold text-[#e4e4e7]">{copy.noCloudServerTitle}</p>
                          <p className="mt-1 text-[11.5px] text-[#71717a]">{copy.noCloudServerDesc}</p>
                        </div>
                      </div>
                      <button
                        onClick={addCloudServer}
                        className="inline-flex items-center justify-center gap-2 rounded-md theme-bg theme-bg-hover px-3 py-2 text-[12px] font-bold text-white transition-colors"
                      >
                        <IconPlus className="h-3.5 w-3.5" /> {copy.addServerTitle}
                      </button>
                    </div>
                  )}
                </section>

                <div className="grid gap-4 lg:grid-cols-[280px_minmax(0,1fr)]">
                  <aside className="min-w-0 rounded-lg border border-[#27272a] bg-[#000000] p-3">
                    <div className="mb-3 flex items-center justify-between gap-2">
                      <div className="min-w-0">
                        <div className="text-[12px] font-bold uppercase tracking-wider text-[#a1a1aa]">{copy.servers}</div>
                        <div className="text-[11px] text-[#71717a]">{copy.configs(cloudServers.length)}</div>
                      </div>
                      <button
                        data-testid="cloud-server-add"
                        onClick={addCloudServer}
                        className="flex h-8 w-8 items-center justify-center rounded-md border border-[#27272a] bg-[#18181b] text-[#e4e4e7] transition-colors hover:border-[#3f3f46]"
                        title={copy.addServerTitle}
                      >
                        <IconPlus className="h-4 w-4" />
                      </button>
                    </div>
                    <input
                      data-testid="cloud-server-search"
                      value={cloudServerSearch}
                      onChange={(e) => setCloudServerSearch(e.target.value)}
                      placeholder={copy.serverSearchPlaceholder}
                      className="mb-3 w-full rounded-md border border-[#27272a] bg-[#09090b] p-2 text-[12px] text-white outline-none theme-ring placeholder:text-[#3f3f46]"
                    />
                    <div data-testid="cloud-server-list" className="max-h-[420px] space-y-2 overflow-y-auto pr-1">
                      {visibleCloudServers.length === 0 ? (
                        <div className="rounded-md border border-dashed border-[#27272a] p-4 text-center text-[12px] text-[#71717a]">
                          {cloudServers.length === 0 && !cloudDraftServer ? copy.noServerConfigs : copy.noMatchingServers}
                        </div>
                      ) : (
                        visibleCloudServers.map((server) => {
                          const isSelectedServer = cloudDraftServer?.id === server.id;
                          const isActiveServer = server.id === activeCloudServerId;
                          const isLockedRunningServer = isModelRuntimeLocked && lockedCloudServerId === server.id;
                          const canRemoveServer = !(isModelRuntimeLocked && (isActiveServer || isLockedRunningServer));
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
                              className={`group w-full rounded-md border p-3 text-left transition-all ${isSelectedServer ? "theme-subtle-border bg-transparent ring-1 ring-inset ring-[var(--accent-light)] hover:bg-[var(--accent-subtle)]" : "border-[#27272a] bg-[#09090b] hover:border-[#3f3f46]"}`}
                            >
                              <div className="flex items-start gap-2">
                                <IconCloud className={`mt-0.5 h-4 w-4 ${isSelectedServer ? "theme-text" : "text-[#71717a]"}`} />
                                <div className="min-w-0 flex-1">
                                  <div className="flex items-center gap-2">
                                    <span className="truncate text-[13px] font-bold text-[#e4e4e7]">{server.name || (isUnsavedServer ? copy.unsavedServer : copy.unnamedServer)}</span>
                                    {isActiveServer && <span className="shrink-0 rounded border theme-subtle-border px-1.5 py-0.5 text-[9px] font-bold uppercase theme-text">{copy.activeProfile}</span>}
                                    {isUnsavedServer && <span className="shrink-0 rounded border border-[#3f3f46] px-1.5 py-0.5 text-[9px] font-bold uppercase text-[#a1a1aa]">{copy.unsaved}</span>}
                                  </div>
                                  <div className="mt-1 flex items-center gap-1.5">
                                    <span className="rounded bg-[#18181b] px-1.5 py-0.5 text-[9px] font-bold uppercase text-[#a1a1aa]">{normalizeCloudProtocol(server.protocol) === "anthropic" ? "Anthropic" : normalizeCloudProtocol(server.protocol) === "gemini" ? "Gemini" : "OpenAI"}</span>
                                    {cloudExperimentalLoginEnabled && normalizeCloudAuthMode(server.auth?.mode) !== "api_key" && <span className="rounded bg-[#18181b] px-1.5 py-0.5 text-[9px] font-bold uppercase text-[#86d9a3]">Login</span>}
                                    {server.model && <span className="truncate text-[10px] text-[#71717a]">{server.model}</span>}
                                  </div>
                                  <div className="mt-1 truncate font-mono text-[10px] text-[#71717a]">{server.endpoint || copy.noEndpoint}</div>
                                </div>
                                <button
                                  type="button"
                                  role="button"
                                  tabIndex={0}
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    if (!canRemoveServer) return;
                                    removeCloudServer(server.id);
                                  }}
                                  onKeyDown={(e) => {
                                    if (e.key === "Enter" || e.key === " ") {
                                      e.preventDefault();
                                      e.stopPropagation();
                                      if (!canRemoveServer) return;
                                      removeCloudServer(server.id);
                                    }
                                  }}
                                  disabled={!canRemoveServer}
                                  className="mt-0.5 rounded p-1 text-[#71717a] opacity-0 transition-colors hover:bg-[#181111] hover:text-[#fca5a5] disabled:cursor-not-allowed disabled:opacity-30 group-hover:opacity-100"
                                  title={!canRemoveServer ? modelRuntimeLockText : language === "zh" ? "删除服务器" : "Delete server"}
                                >
                                  <IconTrash className="h-3.5 w-3.5" />
                                </button>
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
                          <div className="text-[12px] font-bold uppercase tracking-wider text-[#a1a1aa]">{copy.serverConfig}</div>
                          {cloudSaveMsg ? (
                            <p className={`mt-1 text-[11.5px] ${cloudSaveMsg.type === 'error' ? 'text-[#f48771]' : 'text-[#86d9a3]'}`}>{cloudSaveMsg.text}</p>
                          ) : hasCloudDraftChanges ? (
                            <p className="mt-1 text-[11.5px] text-[#facc15]">{copy.unsavedChanges}</p>
                          ) : isLockedCloudDraftServer ? (
                            <p className="mt-1 text-[11.5px] text-[#fbbf24]">{modelRuntimeLockText}</p>
                          ) : (
                            <p className="mt-1 text-[11.5px] text-[#71717a]">{copy.savedConfig}</p>
                          )}
                        </div>
                        <button
                          data-testid="cloud-server-save"
                          onClick={saveCloudServer}
                          disabled={!canSaveCloudServer}
                          className="inline-flex items-center justify-center gap-2 rounded-md theme-bg theme-bg-hover px-3 py-2 text-[12px] font-bold text-white transition-colors disabled:cursor-not-allowed disabled:opacity-40"
                        >
                          <IconSave className="h-3.5 w-3.5" /> {copy.save}
                        </button>
                      </div>
                      <div className="space-y-4">
                        <div>
                          <label className="mb-2 block text-[13px] font-bold text-[#e4e4e7]">{copy.cloudServerName}</label>
                          <input
                            data-testid="cloud-server-name-input"
                            type="text"
                            value={cloudDraftServer.name ?? ""}
                            disabled={!canEditCloudDraftServer}
                            onChange={(e) => updateCloudDraftServer({ name: e.target.value })}
                            placeholder={copy.cloudServerNamePlaceholder}
                            className="w-full rounded-md border border-[#27272a] bg-[#000000] p-2.5 text-[14px] text-white outline-none theme-ring placeholder:text-[#3f3f46] disabled:cursor-not-allowed disabled:opacity-60"
                          />
                        </div>

                        <div data-testid="cloud-auth-mode-section">
                          <label className="mb-2 block text-[13px] font-bold text-[#e4e4e7]">{copy.authMethod}</label>
                          <p className="mb-2 text-[11.5px] text-[#71717a]">{cloudExperimentalLoginEnabled ? copy.authMethodDescLab : copy.authMethodDesc}</p>
                          <div className={`grid gap-2 ${cloudExperimentalLoginEnabled ? "sm:grid-cols-3" : "sm:grid-cols-1"}`}>
                            {[
                              { mode: "api_key", label: copy.authApiKey },
                              ...(cloudExperimentalLoginEnabled ? [
                                { mode: "openai_chatgpt_oauth", label: copy.authOpenAiLogin },
                                { mode: "gemini_google_oauth", label: copy.authGeminiLogin },
                              ] : []),
                            ].map((item) => (
                              <button
                                key={item.mode}
                                type="button"
                                data-testid={`cloud-auth-mode-${item.mode}`}
                                onClick={() => handleCloudAuthModeChange(item.mode)}
                                disabled={!canEditCloudDraftServer}
                                className={settingsOptionButtonClass(cloudAuthMode === item.mode, "rounded-md px-3 py-2 text-[12px] font-bold disabled:cursor-not-allowed disabled:opacity-45")}
                              >
                                {item.label}
                              </button>
                            ))}
                          </div>
                        </div>

                        {cloudExperimentalLoginEnabled && cloudUsesOAuth && (
                          <div data-testid="cloud-oauth-panel" className="rounded-md border border-[#27272a] bg-[#09090b] p-3">
                            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                              <div className="min-w-0">
                                <div className="text-[12px] font-bold text-[#e4e4e7]">
                                  {cloudAuthMode === "openai_chatgpt_oauth" ? copy.openAiExperimentalLoginTitle : copy.geminiExperimentalLoginTitle}
                                </div>
                                <p className="mt-1 text-[11px] leading-relaxed text-[#71717a]">
                                  {cloudAuthMode === "openai_chatgpt_oauth" ? copy.openAiExperimentalLoginDesc : copy.geminiExperimentalLoginDesc}
                                </p>
                                {cloudAuthMode === "gemini_google_oauth" && (
                                  <p className="mt-1 text-[11px] text-[#fbbf24]">{copy.geminiCloudProjectHint}</p>
                                )}
                                <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px]">
                                  <span className={`rounded border px-2 py-0.5 ${cloudAuth.status === "connected" ? "border-[#14532d] bg-[#052e16] text-[#86d9a3]" : "border-[#3f3f46] bg-[#18181b] text-[#a1a1aa]"}`}>
                                    {cloudAuth.status === "connected" ? copy.authConnected : cloudAuth.status === "expired" ? copy.authExpired : copy.authDisconnected}
                                  </span>
                                  {(cloudAuth.email || cloudAuth.accountId) && (
                                    <span className="truncate font-mono text-[#a1a1aa]">{cloudAuth.email || cloudAuth.accountId}</span>
                                  )}
                                </div>
                                {cloudAuth.storage && (
                                  <p className="mt-2 text-[11px] text-[#71717a]">
                                    {cloudAuth.storage === "keychain" ? copy.authStorageKeychain : copy.authStorageFile}
                                  </p>
                                )}
                                {cloudAuthMode === "gemini_google_oauth" && (cloudAuth.projectId || cloudAuth.tier || cloudAuth.codeAssistMessage) && (
                                  <p className="mt-2 text-[11px] text-[#71717a]">
                                    {[
                                      cloudAuth.projectId ? `Project: ${cloudAuth.projectId}` : "",
                                      cloudAuth.tier ? `Tier: ${cloudAuth.tier}` : "",
                                      cloudAuth.codeAssistMessage || "",
                                    ].filter(Boolean).join(" · ")}
                                  </p>
                                )}
                              </div>
                              <div className="flex shrink-0 gap-2">
                                {cloudAuth.status === "connected" ? (
                                  <button
                                    type="button"
                                    onClick={logoutCloudAuth}
                                    disabled={cloudAuthBusy || !canEditCloudDraftServer}
                                    className="rounded-md border border-[#27272a] bg-[#18181b] px-3 py-2 text-[12px] font-bold text-[#a1a1aa] transition-colors hover:text-white disabled:opacity-50"
                                  >
                                    {copy.logout}
                                  </button>
                                ) : (
                                  <button
                                    type="button"
                                    data-testid="cloud-auth-login"
                                    onClick={beginCloudAuth}
                                    disabled={cloudAuthBusy || !canEditCloudDraftServer}
                                    className="rounded-md theme-bg theme-bg-hover px-3 py-2 text-[12px] font-bold text-white transition-colors disabled:opacity-50"
                                  >
                                    {cloudAuthBusy ? copy.loggingIn : copy.login}
                                  </button>
                                )}
                              </div>
                            </div>
                            {cloudAuthSession?.authUrl && (
                              <button
                                type="button"
                                onClick={() => openUrl(cloudAuthSession.authUrl).catch(() => {})}
                                className="mt-3 text-[11px] font-bold theme-text hover:underline"
                              >
                                {copy.authManualOpen}
                              </button>
                            )}
                            {cloudAuthMsg && (
                              <p className={`mt-2 text-[12px] ${cloudAuthMsg.type === "error" ? "text-[#f48771]" : cloudAuthMsg.type === "warning" ? "text-[#fbbf24]" : "text-[#86d9a3]"}`}>
                                {cloudAuthMsg.text}
                              </p>
                            )}
                          </div>
                        )}

                        <div>
                          <label className="mb-2 block text-[13px] font-bold text-[#e4e4e7]">{copy.apiProtocol}</label>
                          <p className="mb-2 text-[11.5px] text-[#71717a]">{copy.apiProtocolDesc}</p>
                          <select
                            value={cloudProtocol}
                            onChange={handleCloudProtocolChange}
                            disabled={!canEditCloudDraftServer}
                            className={settingsSelectClass}
                          >
                            <option value="openai">OpenAI Compatible</option>
                            <option value="anthropic">Anthropic</option>
                            <option value="gemini">Gemini</option>
                          </select>
                        </div>

                        <div>
                          <label className="mb-2 block text-[13px] font-bold text-[#e4e4e7]">{copy.apiEndpoint}</label>
                          <p className="mb-2 text-[11.5px] text-[#71717a]">{cloudEndpointHint}</p>
                          <input
                            data-testid="cloud-server-endpoint-input"
                            type="text"
                            value={draftCloudConfig.endpoint || ""}
                            disabled={cloudAuthMode === "gemini_google_oauth" || !canEditCloudDraftServer}
                            onChange={(e) => {
                              updateCloudDraftServer({ endpoint: e.target.value }, { clearModels: true });
                            }}
                            placeholder={cloudEndpointPlaceholder}
                            className="w-full rounded-md border border-[#27272a] bg-[#000000] p-2.5 font-mono text-[14px] text-white outline-none theme-ring placeholder:text-[#3f3f46] disabled:cursor-not-allowed disabled:opacity-60"
                          />
                        </div>

                        {!cloudUsesOAuth && (
                          <div>
                            <label className="mb-2 block text-[13px] font-bold text-[#e4e4e7]">API Key <span className="font-normal text-[#71717a]">({copy.apiKeyOptional})</span></label>
                            <p className="mb-2 text-[11.5px] text-[#71717a]">{cloudProtocol === "anthropic" ? copy.apiKeyDescAnthropic : cloudProtocol === "gemini" ? copy.apiKeyDescGemini : copy.apiKeyDescOpenAi}</p>
                            <input
                              data-testid="cloud-server-api-key-input"
                              type="password"
                              value={draftCloudConfig.apiKey || ""}
                              disabled={!canEditCloudDraftServer}
                              onChange={(e) => {
                                updateCloudDraftServer({ apiKey: e.target.value }, { clearModels: true });
                              }}
                              placeholder={cloudApiKeyPlaceholder}
                              className="w-full rounded-md border border-[#27272a] bg-[#000000] p-2.5 font-mono text-[14px] text-white outline-none theme-ring placeholder:text-[#3f3f46] disabled:cursor-not-allowed disabled:opacity-60"
                            />
                          </div>
                        )}

                        <details
                          data-testid="cloud-advanced-compatibility"
                          open={isCloudAdvancedOpen}
                          onToggle={(e) => setIsCloudAdvancedOpen((e.currentTarget as HTMLDetailsElement).open)}
                          className="group rounded-md border border-[#27272a] bg-[#09090b] p-3 [&>summary::-webkit-details-marker]:hidden"
                        >
                          <summary style={{ listStyle: "none" }} className="flex cursor-pointer select-none items-center justify-between gap-3">
                            <span className="min-w-0">
                              <span className="block text-[13px] font-bold text-[#e4e4e7]">{copy.advancedCompatibility}</span>
                              <span className="mt-1 block text-[11.5px] text-[#71717a]">{copy.advancedCompatibilityDesc}</span>
                            </span>
                            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-[#27272a] bg-[#000000] text-[#a1a1aa] transition-colors">
                              {isCloudAdvancedOpen ? <IconChevronUp className="h-4 w-4" /> : <IconChevronDown className="h-4 w-4" />}
                            </span>
                          </summary>
                          <div className="mt-4 space-y-4">
                            {cloudProtocol === "openai" && (
                              <div>
                                <label className="mb-2 block text-[13px] font-bold text-[#e4e4e7]">{copy.apiFormat}</label>
                                <p className="mb-2 text-[11.5px] text-[#71717a]">{copy.apiFormatDesc}</p>
                                <select
                                  data-testid="cloud-api-format-select"
                                  value={cloudApiFormat}
                                  onChange={handleCloudApiFormatChange}
                                  disabled={cloudApiFormatLockedByOAuth || !canEditCloudDraftServer}
                                  className={settingsSelectClass}
                                >
                                  <option value="chat_completions">OpenAI Chat Completions</option>
                                  <option value="responses">OpenAI Responses API</option>
                                </select>
                                {cloudApiFormatLockedByOAuth && (
                                  <p className="mt-2 text-[11px] text-[#fbbf24]">{copy.apiFormatLockedByOpenAiOAuth}</p>
                                )}
                              </div>
                            )}

                            <div>
                              <label className="mb-2 block text-[13px] font-bold text-[#e4e4e7]">{copy.toolProtocol}</label>
                              <p className="mb-2 text-[11.5px] text-[#71717a]">{copy.toolProtocolDesc}</p>
                              <select
                                value={normalizeCloudToolProtocol(draftCloudConfig.toolProtocol)}
                                onChange={(e) => updateCloudDraftServer({ toolProtocol: normalizeCloudToolProtocol(e.target.value) })}
                                disabled={!canEditCloudDraftServer}
                                className={settingsSelectClass}
                              >
                                <option value="auto">Auto</option>
                                <option value="native">Native</option>
                                <option value="xml">XML</option>
                              </select>
                            </div>

                            {cloudProtocol === "openai" && cloudApiFormat === "responses" && (
                              <>
                                <div>
                                  <label className="mb-1.5 block text-[12px] text-[#a1a1aa]">{copy.reasoningEffort}</label>
                                  <p className="mb-2 text-[11px] text-[#71717a]">{copy.reasoningEffortDesc}</p>
                                  <select
                                    value={normalizeOpenAiReasoningEffort(draftCloudConfig.reasoningEffort)}
                                    onChange={(e) => updateCloudDraftServer({ reasoningEffort: normalizeOpenAiReasoningEffort(e.target.value) })}
                                    disabled={!canEditCloudDraftServer}
                                    className={settingsSelectClass}
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
                                    disabled={!canEditCloudDraftServer}
                                    onChange={(e) => updateCloudDraftServer({ disableResponseStorage: e.target.checked })}
                                    className="mt-0.5"
                                  />
                                  <span className="min-w-0">
                                    <span className="block text-[12px] font-medium text-[#e4e4e7]">{copy.disableResponseStorage}</span>
                                    <span className="mt-1 block text-[11px] text-[#71717a]">{copy.disableResponseStorageDesc}</span>
                                  </span>
                                </label>

                                <p className="text-[11px] leading-relaxed text-[#71717a]">{cloudAuthMode === "openai_chatgpt_oauth" ? `Codex endpoint: ${OPENAI_CHATGPT_CODEX_ENDPOINT}` : copy.responsesCodexDesc}</p>
                              </>
                            )}

                            <div>
                              <label className="mb-2 block text-[13px] font-bold text-[#e4e4e7]">{copy.additionalHeaders} <span className="font-normal text-[#71717a]">({copy.optional})</span></label>
                              <p className="mb-2 text-[11.5px] text-[#71717a]">{copy.additionalHeadersDesc} {language === "zh" ? "例如" : "For example"} {`{"HTTP-Referer":"https://example.com","X-Title":"MAIN"}`}</p>
                              <textarea
                                value={draftCloudConfig.customHeaders || ""}
                                disabled={!canEditCloudDraftServer}
                                onChange={(e) => {
                                  updateCloudDraftServer({ customHeaders: e.target.value }, { clearModels: true });
                                }}
                                placeholder='{"HTTP-Referer":"https://example.com","X-Title":"MAIN"}'
                                className="min-h-[92px] w-full resize-y rounded-md border border-[#27272a] bg-[#000000] p-2.5 font-mono text-[13px] text-white outline-none theme-ring placeholder:text-[#3f3f46] disabled:cursor-not-allowed disabled:opacity-60"
                              />
                              {parsedCloudCustomHeaders.error ? (
                                <p className="mt-2 text-[12px] text-[#f48771]">{parsedCloudCustomHeaders.error}</p>
                              ) : (
                                <p className="mt-2 text-[11px] text-[#71717a]">{copy.customHeadersCount(Object.keys(parsedCloudCustomHeaders.headers).length)}</p>
                              )}
                            </div>
                          </div>
                        </details>
                      </div>
                    </section>
                      </>
                    ) : (
                      <section className="rounded-lg border border-dashed border-[#27272a] bg-[#000000] p-8 text-center">
                        <div className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-md border border-[#27272a] bg-[#09090b] text-[#71717a]">
                          <IconCloud className="h-4 w-4" />
                        </div>
                        <p className="text-[13px] font-bold text-[#e4e4e7]">{copy.cloudStartTitle}</p>
                        <p className="mt-1 text-[11.5px] text-[#71717a]">{copy.cloudStartDesc}</p>
                        <button
                          onClick={addCloudServer}
                          className="mt-4 inline-flex items-center justify-center gap-2 rounded-md theme-bg theme-bg-hover px-3 py-2 text-[12px] font-bold text-white transition-colors"
                        >
                          <IconPlus className="h-3.5 w-3.5" /> {copy.addServerTitle}
                        </button>
                      </section>
                    )}
                  </div>
                </div>

              </div>
            )}
          </div>
        </div>
        <div className="shrink-0 px-6 py-4 border-t border-[#27272a] bg-[#000000] flex justify-end gap-3">
          <button onClick={handleCancelSettings} disabled={isApplyingAppIcon} className="px-5 py-1.5 text-[13px] text-[#a1a1aa] hover:text-white transition-colors disabled:cursor-wait disabled:opacity-50">{copy.cancel}</button>
          <button onClick={handleDoneSettings} disabled={isApplyingAppIcon} className="px-6 py-1.5 theme-bg theme-bg-hover text-[13px] font-bold rounded-md transition-colors shadow-sm disabled:cursor-wait disabled:opacity-60">{copy.done}</button>
        </div>
      </div>
    </div>
  ) : null;
}
