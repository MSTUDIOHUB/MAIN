// @ts-nocheck
import React, { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import {
  IconCheck,
  IconClose,
  IconGlobe,
  IconImageIcon,
  IconRefresh,
  IconZap,
} from "./Icons";
import { useAppStore } from "../store/useAppStore";
import {
  IMAGE_STUDIO_LOCAL_DEFAULT_ENDPOINT,
  IMAGE_STUDIO_WEB_FALLBACK_ENDPOINT,
  checkImageStudioEngineStatus,
  getDefaultImageStudioEndpointForServiceFamily,
  mapLocalModelProviderToImageStudioServiceFamily,
  normalizeImageStudioConfig,
  isImageModelName,
} from "../lib/imageStudio";

const settingsSectionRowClass = "grid gap-3 lg:grid-cols-[minmax(190px,300px)_minmax(0,1fr)] lg:items-start lg:gap-8";
const settingsControlColumnClass = "w-full lg:ml-auto lg:max-w-[620px]";
const settingsSelectClass = "w-full rounded-md border border-[#27272a] bg-[#000000] p-2.5 text-[14px] text-white outline-none theme-ring transition-all cursor-pointer focus:border-[var(--accent)] focus:ring-1 focus:ring-inset focus:ring-[var(--accent-light)]";
const settingsInputClass = "w-full rounded-md border border-[#27272a] bg-[#000000] p-2.5 text-[14px] text-white outline-none theme-ring transition-all focus:border-[var(--accent)] focus:ring-1 focus:ring-inset focus:ring-[var(--accent-light)]";
const settingsSecondaryButtonClass = "rounded-md border border-[#27272a] bg-[#18181b] px-3 py-2 text-[12px] font-bold text-[#e4e4e7] transition-colors hover:border-[#3f3f46] hover:text-white disabled:cursor-wait disabled:opacity-50";

function settingsOptionButtonClass(isSelected: boolean, extra = "") {
  return `${isSelected ? "theme-bg shadow-sm text-white border-transparent" : "border-[#27272a] bg-[#18181b] text-[#a1a1aa] hover:text-white hover:border-[#3f3f46]"} border transition-colors ${extra}`.trim();
}

export default function ImageStudioSetupModal() {
  const language = useAppStore((s) => s.config.language === "en" ? "en" : "zh");
  const imageStudio = useAppStore((s) => s.imageStudio);
  const mainLocalConfig = useAppStore((s) => s.config.local);
  const setImageStudioConfig = useAppStore((s) => s.setImageStudioConfig);
  const setImageStudioStatus = useAppStore((s) => s.setImageStudioStatus);
  const setImageStudioSetupGuideOpen = useAppStore((s) => s.setImageStudioSetupGuideOpen);

  const [section, setSection] = useState<"local" | "web">("local");
  const [localEndpointDraft, setLocalEndpointDraft] = useState(imageStudio.config.local.endpoint);
  const [localModelDraft, setLocalModelDraft] = useState(imageStudio.config.local.model);
  const [localServiceFamilyDraft, setLocalServiceFamilyDraft] = useState(imageStudio.config.local.serviceFamily || "omlx");
  const [webEndpointDraft, setWebEndpointDraft] = useState(imageStudio.config.web.endpoint);
  
  const [draftWebPromptRefine, setDraftWebPromptRefine] = useState(imageStudio.config.web.promptRefine);
  const [draftWebEnabled, setDraftWebEnabled] = useState(imageStudio.config.web.enabled);
  const [draftProvider, setDraftProvider] = useState(imageStudio.config.provider);
  const [connectionStatusMsg, setConnectionStatusMsg] = useState<{ type: "success" | "error" | "warning" | "info"; text: string } | null>(null);
  const [checkingProvider, setCheckingProvider] = useState<"local_image_service" | "web_fallback" | null>(null);

  useEffect(() => {
    if (!imageStudio.setupGuideOpen) return;
    setLocalEndpointDraft(imageStudio.config.local.endpoint);
    setLocalModelDraft(imageStudio.config.local.model);
    setLocalServiceFamilyDraft(imageStudio.config.local.serviceFamily || "omlx");
    setWebEndpointDraft(imageStudio.config.web.endpoint);
    setDraftWebPromptRefine(imageStudio.config.web.promptRefine);
    setDraftWebEnabled(imageStudio.config.web.enabled);
    setDraftProvider(imageStudio.config.provider);
    setSection(imageStudio.config.provider === "web_fallback" ? "web" : "local");
    setConnectionStatusMsg(null);
  }, [
    imageStudio.config.local.endpoint,
    imageStudio.config.local.model,
    imageStudio.config.local.serviceFamily,
    imageStudio.config.provider,
    imageStudio.config.web.endpoint,
    imageStudio.config.web.promptRefine,
    imageStudio.config.web.enabled,
    imageStudio.setupGuideOpen,
  ]);

  const copy = useMemo(() => ({
    title: language === "en" ? "Image Studio Setup" : "图像工作室设置",
    subtitle: language === "en"
      ? "Configure local-first image generation and hosted fallback parameters."
      : "配置本地生图服务及云端托管 fallback 参数。",
    local: language === "en" ? "Local Image Service" : "本地图片服务",
    web: language === "en" ? "HiDream Web Fallback" : "HiDream 网页 Fallback",
    active: language === "en" ? "Active Provider" : "当前已启用",
    setActive: language === "en" ? "Set As Active" : "设为当前 Provider",
    endpoint: language === "en" ? "Endpoint" : "服务地址",
    model: language === "en" ? "Model ID" : "模型",
    localProvider: language === "en" ? "Provider Family" : "服务提供商",
    check: language === "en" ? "Test Connection" : "测试连接并扫描",
    checking: language === "en" ? "Testing..." : "正在检测...",
    close: language === "en" ? "Close" : "关闭",
    cancel: language === "en" ? "Cancel" : "取消",
    done: language === "en" ? "Done" : "确定",
    useCurrentLocal: language === "en" ? "Adopt MAIN Local Settings" : "复制当前本地设置",
    currentLocalHint: language === "en"
      ? "Copy provider / endpoint / model from MAIN local settings."
      : "从 MAIN 的本地模型设置复制 provider、endpoint 和 model 选项。",
    discoveredModels: language === "en" ? "Discovered Models" : "已发现模型",
    localEmpty: language === "en"
      ? "No models discovered yet. Type a model ID manually or click test connection."
      : "暂未发现模型，你可以手动填写 model id 或点击测试连接扫描。",
    promptRefine: language === "en" ? "Prompt Refine" : "提示词润色",
    webEnabled: language === "en" ? "Enable Web Fallback" : "启用网页 Fallback",
    enabled: language === "en" ? "Enabled" : "已启用",
    disabled: language === "en" ? "Disabled" : "已关闭",
    serviceFamilies: {
      omlx: language === "en" ? "OMLX (MLX for Mac)" : "OMLX (Mac 本地 MLX)",
      ollama: "Ollama",
      openai_compatible: language === "en" ? "OpenAI-compatible" : "OpenAI 兼容接口",
    },
  }), [language]);

  if (!imageStudio.setupGuideOpen || typeof document === "undefined") return null;

  const localDiscoveredModels = imageStudio.status.providerKind === "local_image_service"
    ? (Array.isArray(imageStudio.status.discoveredModels) ? imageStudio.status.discoveredModels : [])
    : [];

  const canAdoptMainLocalSettings = Boolean(mainLocalConfig?.endpoint || mainLocalConfig?.provider || mainLocalConfig?.model);

  const buildDraftConfig = (providerKind: "local_image_service" | "web_fallback") =>
    normalizeImageStudioConfig({
      ...imageStudio.config,
      provider: providerKind,
      local: {
        endpoint: localEndpointDraft.trim() || IMAGE_STUDIO_LOCAL_DEFAULT_ENDPOINT,
        model: localModelDraft.trim(),
        protocol: "openai_images",
        serviceFamily: localServiceFamilyDraft,
      },
      web: {
        endpoint: webEndpointDraft.trim() || IMAGE_STUDIO_WEB_FALLBACK_ENDPOINT,
        promptRefine: draftWebPromptRefine,
        enabled: draftWebEnabled,
      },
    });

  const applyLocalServiceFamily = (nextFamily: "omlx" | "ollama" | "openai_compatible") => {
    setLocalServiceFamilyDraft(nextFamily);
    const suggestedEndpoint = getDefaultImageStudioEndpointForServiceFamily(nextFamily);
    const normalizedCurrentEndpoint = localEndpointDraft.trim();
    const currentDefaults = new Set([
      IMAGE_STUDIO_LOCAL_DEFAULT_ENDPOINT,
      getDefaultImageStudioEndpointForServiceFamily(localServiceFamilyDraft),
      "http://127.0.0.1:11434/v1",
    ]);
    if (!normalizedCurrentEndpoint || currentDefaults.has(normalizedCurrentEndpoint)) {
      setLocalEndpointDraft(suggestedEndpoint);
    }
  };

  const adoptMainLocalSettings = () => {
    const nextFamily = mapLocalModelProviderToImageStudioServiceFamily(mainLocalConfig?.provider);
    setSection("local");
    setLocalServiceFamilyDraft(nextFamily);
    setLocalEndpointDraft((mainLocalConfig?.endpoint || getDefaultImageStudioEndpointForServiceFamily(nextFamily)).trim());
    setLocalModelDraft((mainLocalConfig?.model || "").trim());
  };

  const runCheck = async (providerKind: "local_image_service" | "web_fallback") => {
    if (checkingProvider) return;
    setCheckingProvider(providerKind);
    setConnectionStatusMsg({
      type: "info",
      text: language === "en" ? "Testing connection and scanning models..." : "正在测试连接并扫描模型...",
    });
    try {
      const draftConfig = buildDraftConfig(providerKind);
      const status = await checkImageStudioEngineStatus(draftConfig);
      
      if (status.state === "ready") {
        if (status.message.includes("警告") || status.message.includes("warning")) {
          setConnectionStatusMsg({ type: "warning", text: status.message });
        } else {
          setConnectionStatusMsg({ type: "success", text: status.message });
        }
        if (providerKind === "local_image_service") {
          setImageStudioStatus(status);
        }
      } else {
        setConnectionStatusMsg({ type: "error", text: status.message });
      }
    } catch (err: any) {
      setConnectionStatusMsg({ type: "error", text: err.message || String(err) });
    } finally {
      setCheckingProvider(null);
    }
  };

  const handleCancel = () => {
    setImageStudioSetupGuideOpen(false);
  };

  const handleDone = () => {
    setImageStudioConfig({
      provider: draftProvider,
      local: {
        endpoint: localEndpointDraft.trim() || IMAGE_STUDIO_LOCAL_DEFAULT_ENDPOINT,
        model: localModelDraft.trim(),
        protocol: "openai_images",
        serviceFamily: localServiceFamilyDraft,
      },
      web: {
        endpoint: webEndpointDraft.trim() || IMAGE_STUDIO_WEB_FALLBACK_ENDPOINT,
        promptRefine: draftWebPromptRefine,
        enabled: draftWebEnabled,
      },
    });
    setImageStudioSetupGuideOpen(false);
  };

  return createPortal(
    <div className="fixed inset-0 z-[120] flex items-center justify-center bg-black/80 p-4 backdrop-blur-sm">
      <div
        className="flex w-[min(1080px,94vw)] flex-col overflow-hidden rounded-xl border border-[#27272a] bg-[#09090b] shadow-2xl"
        style={{ height: "min(720px, calc(100vh - 32px))", maxHeight: "calc(100vh - 32px)" }}
        role="dialog"
        aria-modal="true"
      >
        {/* Header */}
        <div className="flex shrink-0 items-center justify-between border-b border-[#27272a] bg-[#000000] px-5 py-4">
          <div className="min-w-0">
            <h2 className="flex items-center gap-2 text-base font-bold text-white">
              <IconImageIcon className="h-5 w-5" />
              {copy.title}
            </h2>
            <p className="mt-1 text-[12px] leading-relaxed text-[#71717a]">{copy.subtitle}</p>
          </div>
          <button
            type="button"
            data-testid="image-studio-settings-close"
            onClick={handleCancel}
            className="text-[#a1a1aa] transition-colors hover:text-white"
            title={copy.close}
            aria-label={copy.close}
          >
            <IconClose className="h-4 w-4" />
          </button>
        </div>

        {/* Workspace Panels */}
        <div className="flex min-h-0 flex-1">
          {/* Sidebar */}
          <div className="flex w-52 shrink-0 flex-col gap-1 overflow-y-auto border-r border-[#27272a] bg-[#000000] p-2">
            <button
              type="button"
              data-testid="image-studio-settings-tab-local"
              onClick={() => { setSection("local"); setConnectionStatusMsg(null); }}
              className={`rounded-md px-4 py-2.5 text-left text-[13px] font-medium transition-colors ${
                section === "local" ? "theme-bg shadow-sm text-white" : "text-[#a1a1aa] hover:bg-[#18181b] hover:text-[#e4e4e7]"
              }`}
            >
              <span className="flex items-center gap-2">
                <IconZap className="h-4 w-4" />
                {copy.local}
              </span>
            </button>
            <button
              type="button"
              data-testid="image-studio-settings-tab-web"
              onClick={() => { setSection("web"); setConnectionStatusMsg(null); }}
              className={`rounded-md px-4 py-2.5 text-left text-[13px] font-medium transition-colors ${
                section === "web" ? "theme-bg shadow-sm text-white" : "text-[#a1a1aa] hover:bg-[#18181b] hover:text-[#e4e4e7]"
              }`}
            >
              <span className="flex items-center gap-2">
                <IconGlobe className="h-4 w-4" />
                {copy.web}
              </span>
            </button>
          </div>

          {/* Right Panel Main Content */}
          <div className="min-h-0 flex-1 overflow-y-auto bg-[#09090b] p-6 pb-8">
            {section === "local" ? (
              <div className="space-y-6">
                <div className="flex items-center justify-between">
                  <h3 className="text-[13px] font-bold text-[#a1a1aa] uppercase tracking-wider">{copy.local}</h3>
                  <div className="flex items-center gap-2">
                    {canAdoptMainLocalSettings && (
                      <button
                        type="button"
                        data-testid="image-studio-adopt-main-local-settings"
                        onClick={adoptMainLocalSettings}
                        className={settingsOptionButtonClass(false, "rounded px-2.5 py-1.5 text-[11px] font-bold uppercase tracking-wider")}
                        title={copy.currentLocalHint}
                      >
                        {copy.useCurrentLocal}
                      </button>
                    )}
                    <button
                      type="button"
                      data-testid="local-active-provider-button"
                      onClick={() => setDraftProvider("local_image_service")}
                      className={settingsOptionButtonClass(draftProvider === "local_image_service", "rounded px-2.5 py-1.5 text-[11px] font-bold uppercase tracking-wider")}
                    >
                      {draftProvider === "local_image_service" ? copy.active : copy.setActive}
                    </button>
                  </div>
                </div>

                <div className={settingsSectionRowClass}>
                  <div>
                    <label className="block text-[13px] font-bold text-[#e4e4e7]">{copy.localProvider}</label>
                  </div>
                  <div className={settingsControlColumnClass}>
                    <select
                      data-testid="image-studio-local-provider-select"
                      value={localServiceFamilyDraft}
                      onChange={(event) => applyLocalServiceFamily(event.target.value)}
                      className={settingsSelectClass}
                    >
                      <option value="omlx">{copy.serviceFamilies.omlx}</option>
                      <option value="ollama">{copy.serviceFamilies.ollama}</option>
                      <option value="openai_compatible">{copy.serviceFamilies.openai_compatible}</option>
                    </select>
                  </div>
                </div>

                <div className={`${settingsSectionRowClass} border-t border-[#27272a] pt-5`}>
                  <div>
                    <label className="block text-[13px] font-bold text-[#e4e4e7]">{copy.endpoint}</label>
                  </div>
                  <div className={settingsControlColumnClass}>
                    <input
                      data-testid="image-studio-local-endpoint-input"
                      value={localEndpointDraft}
                      onChange={(event) => setLocalEndpointDraft(event.target.value)}
                      className={`${settingsInputClass} font-mono`}
                      spellCheck={false}
                      placeholder={IMAGE_STUDIO_LOCAL_DEFAULT_ENDPOINT}
                    />
                  </div>
                </div>

                <div className={`${settingsSectionRowClass} border-t border-[#27272a] pt-5`}>
                  <div>
                    <label className="block text-[13px] font-bold text-[#e4e4e7]">{copy.model}</label>
                  </div>
                  <div className={settingsControlColumnClass}>
                    <div className="flex gap-2">
                      <input
                        data-testid="image-studio-local-model-input"
                        value={localModelDraft}
                        onChange={(event) => setLocalModelDraft(event.target.value)}
                        className={`${settingsInputClass} font-mono flex-1`}
                        spellCheck={false}
                        placeholder={language === "en" ? "Optional model ID" : "可选 model id"}
                      />
                      <button
                        type="button"
                        onClick={() => void runCheck("local_image_service")}
                        disabled={checkingProvider !== null}
                        className={`${settingsSecondaryButtonClass} flex items-center gap-1.5 shrink-0`}
                      >
                        <IconRefresh className={`h-3.5 w-3.5 ${checkingProvider ? "animate-spin" : ""}`} />
                        {checkingProvider ? copy.checking : copy.check}
                      </button>
                    </div>

                    {connectionStatusMsg && (
                      <div className={`mt-3 rounded-md border px-3 py-2.5 text-[12px] leading-relaxed ${
                        connectionStatusMsg.type === "success"
                          ? "border-[rgba(34,197,94,0.24)] bg-[rgba(34,197,94,0.08)] text-[#86efac]"
                          : connectionStatusMsg.type === "error"
                            ? "border-[#3f1f1f] bg-[#181111] text-[#fca5a5]"
                            : connectionStatusMsg.type === "warning"
                              ? "border-[#3f2f1f] bg-[#18110a] text-[#fbbf24]"
                              : "border-[#27272a] bg-[#000000] text-[#a1a1aa]"
                      }`}>
                        {connectionStatusMsg.text}
                      </div>
                    )}

                    {localDiscoveredModels.length > 0 ? (
                      <div className="mt-4">
                        <span className="block text-[11px] font-bold uppercase tracking-wider text-[#71717a] mb-2">{copy.discoveredModels}</span>
                        <div className="flex flex-wrap gap-2">
                          {localDiscoveredModels.map((modelId) => {
                            const selected = localModelDraft === modelId;
                            return (
                              <button
                                key={modelId}
                                type="button"
                                data-testid="image-studio-discovered-model"
                                onClick={() => setLocalModelDraft(modelId)}
                                className={settingsOptionButtonClass(selected, "rounded-full px-3 py-1.5 text-[11px]")}
                              >
                                {modelId}
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    ) : (
                      <div className="mt-4 rounded-md border border-[#27272a] bg-[#000000] px-3 py-2 text-[12px] text-[#71717a]">
                        {copy.localEmpty}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            ) : (
              <div className="space-y-6">
                <div className="flex items-center justify-between">
                  <h3 className="text-[13px] font-bold text-[#a1a1aa] uppercase tracking-wider">{copy.web}</h3>
                  <button
                    type="button"
                    data-testid="web-active-provider-button"
                    onClick={() => setDraftProvider("web_fallback")}
                    className={settingsOptionButtonClass(draftProvider === "web_fallback", "rounded px-2.5 py-1.5 text-[11px] font-bold uppercase tracking-wider")}
                  >
                    {draftProvider === "web_fallback" ? copy.active : copy.setActive}
                  </button>
                </div>

                <div className={settingsSectionRowClass}>
                  <div>
                    <label className="block text-[13px] font-bold text-[#e4e4e7]">{copy.endpoint}</label>
                  </div>
                  <div className={settingsControlColumnClass}>
                    <div className="flex gap-2">
                      <input
                        data-testid="image-studio-web-endpoint-input"
                        value={webEndpointDraft}
                        onChange={(event) => setWebEndpointDraft(event.target.value)}
                        className={`${settingsInputClass} font-mono flex-1`}
                        spellCheck={false}
                        placeholder={IMAGE_STUDIO_WEB_FALLBACK_ENDPOINT}
                      />
                      <button
                        type="button"
                        onClick={() => void runCheck("web_fallback")}
                        disabled={checkingProvider !== null}
                        className={`${settingsSecondaryButtonClass} flex items-center gap-1.5 shrink-0`}
                      >
                        <IconRefresh className={`h-3.5 w-3.5 ${checkingProvider ? "animate-spin" : ""}`} />
                        {checkingProvider ? copy.checking : copy.check}
                      </button>
                    </div>

                    {connectionStatusMsg && (
                      <div className={`mt-3 rounded-md border px-3 py-2.5 text-[12px] leading-relaxed ${
                        connectionStatusMsg.type === "success"
                          ? "border-[rgba(34,197,94,0.24)] bg-[rgba(34,197,94,0.08)] text-[#86efac]"
                          : connectionStatusMsg.type === "error"
                            ? "border-[#3f1f1f] bg-[#181111] text-[#fca5a5]"
                            : "border-[#27272a] bg-[#000000] text-[#a1a1aa]"
                      }`}>
                        {connectionStatusMsg.text}
                      </div>
                    )}
                  </div>
                </div>

                <div className={`${settingsSectionRowClass} border-t border-[#27272a] pt-5`}>
                  <div>
                    <span className="block text-[13px] font-bold text-[#e4e4e7]">{copy.promptRefine}</span>
                  </div>
                  <div className={`${settingsControlColumnClass} flex items-center justify-between rounded-lg border border-[#27272a] bg-[#000000] px-4 py-3`}>
                    <span className={`min-w-0 text-[12px] font-bold ${draftWebPromptRefine ? "theme-text" : "text-[#a1a1aa]"}`}>
                      {draftWebPromptRefine ? copy.enabled : copy.disabled}
                    </span>
                    <button
                      type="button"
                      role="switch"
                      aria-checked={draftWebPromptRefine}
                      data-testid="image-studio-web-refine-switch"
                      aria-label={copy.promptRefine}
                      onClick={() => setDraftWebPromptRefine((value) => !value)}
                      className={`relative inline-flex h-6 w-11 items-center rounded-full border p-0.5 transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[#000000] ${
                        draftWebPromptRefine
                          ? "border-transparent shadow-[0_0_12px_var(--accent-subtle)]"
                          : "border-[#3f3f46] bg-[#18181b]"
                      }`}
                      style={draftWebPromptRefine ? { backgroundColor: "var(--accent)" } : undefined}
                    >
                      <span
                        className={`block h-5 w-5 rounded-full bg-white shadow-sm transition-transform duration-200 ${
                          draftWebPromptRefine ? "translate-x-5" : "translate-x-0"
                        }`}
                      />
                    </button>
                  </div>
                </div>

                <div className={`${settingsSectionRowClass} border-t border-[#27272a] pt-5`}>
                  <div>
                    <span className="block text-[13px] font-bold text-[#e4e4e7]">{copy.webEnabled}</span>
                  </div>
                  <div className={`${settingsControlColumnClass} flex items-center justify-between rounded-lg border border-[#27272a] bg-[#000000] px-4 py-3`}>
                    <span className={`min-w-0 text-[12px] font-bold ${draftWebEnabled ? "theme-text" : "text-[#a1a1aa]"}`}>
                      {draftWebEnabled ? copy.enabled : copy.disabled}
                    </span>
                    <button
                      type="button"
                      role="switch"
                      aria-checked={draftWebEnabled}
                      data-testid="image-studio-web-enabled-switch"
                      aria-label={copy.webEnabled}
                      onClick={() => setDraftWebEnabled((value) => !value)}
                      className={`relative inline-flex h-6 w-11 items-center rounded-full border p-0.5 transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[#000000] ${
                        draftWebEnabled
                          ? "border-transparent shadow-[0_0_12px_var(--accent-subtle)]"
                          : "border-[#3f3f46] bg-[#18181b]"
                      }`}
                      style={draftWebEnabled ? { backgroundColor: "var(--accent)" } : undefined}
                    >
                      <span
                        className={`block h-5 w-5 rounded-full bg-white shadow-sm transition-transform duration-200 ${
                          draftWebEnabled ? "translate-x-5" : "translate-x-0"
                        }`}
                      />
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="shrink-0 px-6 py-4 border-t border-[#27272a] bg-[#000000] flex justify-end gap-3">
          <button
            onClick={handleCancel}
            className="px-5 py-1.5 text-[13px] text-[#a1a1aa] hover:text-white transition-colors"
          >
            {copy.cancel}
          </button>
          <button
            onClick={handleDone}
            className="px-6 py-1.5 theme-bg theme-bg-hover text-[13px] font-bold rounded-md transition-colors shadow-sm"
          >
            {copy.done}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
