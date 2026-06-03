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
} from "../lib/imageStudio";

const settingsSectionRowClass = "grid gap-3 lg:grid-cols-[minmax(190px,300px)_minmax(0,1fr)] lg:items-start lg:gap-8";
const settingsControlColumnClass = "w-full lg:ml-auto lg:max-w-[620px]";
const settingsSelectClass = "w-full rounded-md border border-[#27272a] bg-[#000000] p-2.5 text-[14px] text-white outline-none theme-ring transition-all cursor-pointer focus:border-[var(--accent)] focus:ring-1 focus:ring-inset focus:ring-[var(--accent-light)]";
const settingsInputClass = "w-full rounded-md border border-[#27272a] bg-[#000000] p-2.5 text-[14px] text-white outline-none theme-ring transition-all focus:border-[var(--accent)] focus:ring-1 focus:ring-inset focus:ring-[var(--accent-light)]";
const settingsSecondaryButtonClass = "rounded-md border border-[#27272a] bg-[#18181b] px-3 py-2 text-[12px] font-bold text-[#e4e4e7] transition-colors hover:border-[#3f3f46] hover:text-white disabled:cursor-wait disabled:opacity-50";
const settingsAccentButtonClass = "rounded-md border border-[var(--accent-subtle-border)] bg-[var(--accent-subtle)] px-3 py-2 text-[12px] font-bold text-white transition-colors hover:bg-[var(--accent)] disabled:cursor-wait disabled:opacity-50";

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
  const [checkingProvider, setCheckingProvider] = useState<"local_image_service" | "web_fallback" | null>(null);

  useEffect(() => {
    if (!imageStudio.setupGuideOpen) return;
    setLocalEndpointDraft(imageStudio.config.local.endpoint);
    setLocalModelDraft(imageStudio.config.local.model);
    setLocalServiceFamilyDraft(imageStudio.config.local.serviceFamily || "omlx");
    setWebEndpointDraft(imageStudio.config.web.endpoint);
    setSection(imageStudio.config.provider === "web_fallback" ? "web" : "local");
  }, [
    imageStudio.config.local.endpoint,
    imageStudio.config.local.model,
    imageStudio.config.local.serviceFamily,
    imageStudio.config.provider,
    imageStudio.config.web.endpoint,
    imageStudio.setupGuideOpen,
  ]);

  const copy = useMemo(() => ({
    title: language === "en" ? "Image Studio" : "图像工作室",
    subtitle: language === "en"
      ? "Local-first image generation with a hosted HiDream Web fallback inside the same studio."
      : "以本地生图为主，并在同一工作室里保留 HiDream Web 作为托管 fallback。",
    local: language === "en" ? "Local Image Service" : "本地图片服务",
    localDesc: language === "en"
      ? "Use the same endpoint and model-discovery pattern as MAIN local settings, including OMLX and Ollama."
      : "复用 MAIN 本地模型设置的 endpoint 与模型发现习惯，直接支持 OMLX 和 Ollama 风格识别。",
    web: language === "en" ? "HiDream Web" : "HiDream 网页",
    webDesc: language === "en"
      ? "Keep HiDream Web available as a lighter browser-side route when you want a hosted fallback."
      : "把 HiDream Web 保留为网页端次级路径，作为可选的托管 fallback。",
    active: language === "en" ? "Active Provider" : "当前 Provider",
    providerStatus: language === "en" ? "Provider Status" : "Provider 状态",
    localProvider: language === "en" ? "Local Provider" : "本地 Provider",
    endpoint: language === "en" ? "Endpoint" : "服务地址",
    model: language === "en" ? "Model" : "模型",
    protocol: language === "en" ? "Protocol" : "协议",
    protocolValue: "OpenAI Images /v1/images/generations",
    save: language === "en" ? "Save Settings" : "保存设置",
    setActive: language === "en" ? "Use For Generation" : "设为当前生成 Provider",
    check: language === "en" ? "Check Connection" : "检测连接",
    checking: language === "en" ? "Checking..." : "检测中...",
    close: language === "en" ? "Close" : "关闭",
    useCurrentLocal: language === "en" ? "Use Current Local Setup" : "使用当前本地模型设置",
    currentLocalHint: language === "en"
      ? "Copy provider / endpoint / model from MAIN local settings without binding the two configs together."
      : "从 MAIN 的本地模型设置复制 provider、endpoint 和 model，但两套配置依然独立保存。",
    discoveredModels: language === "en" ? "Discovered Models" : "已发现模型",
    localEmpty: language === "en"
      ? "No models discovered yet. You can still type a model id manually."
      : "暂未发现模型，你也可以先手动填写 model id。",
    promptRefine: language === "en" ? "Prompt Refine" : "提示词润色",
    webEnabled: language === "en" ? "HiDream Web Availability" : "HiDream Web 可用性",
    enabled: language === "en" ? "Enabled" : "已启用",
    disabled: language === "en" ? "Disabled" : "已关闭",
    localRuntime: language === "en" ? "Local Runtime" : "本地运行时",
    webRuntime: language === "en" ? "Web Fallback" : "网页 Fallback",
    localStatusIdle: language === "en"
      ? "Save or check this section to refresh local model discovery."
      : "保存或检测这一项后，MAIN 会刷新本地模型发现结果。",
    webStatusIdle: language === "en"
      ? "HiDream Web can stay disabled until you explicitly want a hosted generation route."
      : "HiDream Web 可以保持关闭，等你明确需要网页端托管生图时再开启。",
    localHint: language === "en"
      ? "MAIN probes /health plus provider-specific discovery endpoints, then sends generation requests through /v1/images/generations."
      : "MAIN 会先探测 /health 和 provider 对应的发现接口，再通过 /v1/images/generations 发起生成。",
    localHintSecondary: language === "en"
      ? "Loopback and private-network endpoints are allowed. Public-facing local-image endpoints stay blocked by design."
      : "允许回环地址和私网 endpoint，公网形式的本地生图地址会继续被阻止。",
    webHint: language === "en"
      ? "Disabling HiDream Web removes it from generation until you explicitly re-enable or switch back."
      : "关闭 HiDream Web 后，它会退出当前生图路径，直到你再次开启或重新切换回来。",
    serviceFamilies: {
      omlx: language === "en" ? "OMLX (MLX for Mac)" : "OMLX (Mac 本地 MLX)",
      ollama: "Ollama",
      openai_compatible: language === "en" ? "OpenAI-compatible" : "OpenAI 兼容接口",
    },
    stateLabel: {
      ready: language === "en" ? "Ready" : "已就绪",
      missing: language === "en" ? "Needs Setup" : "待设置",
      error: language === "en" ? "Error" : "错误",
      unknown: language === "en" ? "Not Checked" : "未检测",
    },
    localSectionDetail: language === "en" ? "Primary workflow" : "主工作流",
    webSectionDetail: language === "en" ? "Secondary route" : "次级路径",
  }), [language]);

  if (!imageStudio.setupGuideOpen || typeof document === "undefined") return null;

  const activeProviderLabel = imageStudio.config.provider === "web_fallback" ? copy.web : copy.local;
  const statusKey = imageStudio.status.state || "unknown";
  const statusToneClass = imageStudio.status.state === "ready"
    ? "border-[rgba(34,197,94,0.28)] bg-[rgba(34,197,94,0.10)] text-[#86efac]"
    : imageStudio.status.state === "error"
      ? "border-[#3f1f1f] bg-[#181111] text-[#fca5a5]"
      : imageStudio.status.state === "missing"
        ? "border-[#3f2f1f] bg-[#18110a] text-[#fbbf24]"
        : "border-[#27272a] bg-[#000000] text-[#a1a1aa]";
  const localDiscoveredModels = imageStudio.status.providerKind === "local_image_service"
    ? (Array.isArray(imageStudio.status.discoveredModels) ? imageStudio.status.discoveredModels : [])
    : [];
  const sectionStatusMessage = section === "local"
    ? (imageStudio.status.providerKind === "local_image_service" ? imageStudio.status.message : copy.localStatusIdle)
    : (imageStudio.status.providerKind === "web_fallback" ? imageStudio.status.message : copy.webStatusIdle);
  const canAdoptMainLocalSettings = Boolean(mainLocalConfig?.endpoint || mainLocalConfig?.provider || mainLocalConfig?.model);

  const buildLocalPatch = () => ({
    local: {
      endpoint: (localEndpointDraft || getDefaultImageStudioEndpointForServiceFamily(localServiceFamilyDraft)).trim() || IMAGE_STUDIO_LOCAL_DEFAULT_ENDPOINT,
      model: localModelDraft.trim(),
      protocol: "openai_images",
      serviceFamily: localServiceFamilyDraft,
    },
  });

  const buildWebPatch = (enabled = imageStudio.config.web.enabled) => ({
    web: {
      endpoint: (webEndpointDraft || IMAGE_STUDIO_WEB_FALLBACK_ENDPOINT).trim() || IMAGE_STUDIO_WEB_FALLBACK_ENDPOINT,
      promptRefine: imageStudio.config.web.promptRefine,
      enabled,
    },
  });

  const persistLocalSettings = (activate = false) => {
    setImageStudioConfig({
      ...(activate ? { provider: "local_image_service" } : {}),
      ...buildLocalPatch(),
    });
  };

  const persistWebSettings = (options?: { activate?: boolean; enabled?: boolean }) => {
    const nextEnabled = options?.activate ? true : (options?.enabled ?? imageStudio.config.web.enabled);
    setImageStudioConfig({
      ...(options?.activate ? { provider: "web_fallback" } : {}),
      ...buildWebPatch(nextEnabled),
    });
  };

  const buildDraftConfig = (providerKind: "local_image_service" | "web_fallback") =>
    normalizeImageStudioConfig({
      ...imageStudio.config,
      provider: providerKind,
      ...(providerKind === "local_image_service" ? buildLocalPatch() : buildWebPatch(providerKind === "web_fallback" ? imageStudio.config.web.enabled : undefined)),
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
    try {
      if (providerKind === "local_image_service") {
        persistLocalSettings(false);
      } else {
        persistWebSettings({ activate: false });
      }
      const status = await checkImageStudioEngineStatus(buildDraftConfig(providerKind));
      setImageStudioStatus(status);
    } finally {
      setCheckingProvider(null);
    }
  };

  const toggleWebEnabled = () => {
    const nextEnabled = !imageStudio.config.web.enabled;
    if (!nextEnabled && imageStudio.config.provider === "web_fallback") {
      setImageStudioConfig({
        provider: "local_image_service",
        ...buildWebPatch(false),
      });
      return;
    }
    persistWebSettings({ enabled: nextEnabled });
  };

  return createPortal(
    <div className="fixed inset-0 z-[120] flex items-center justify-center bg-black/80 p-4 backdrop-blur-sm">
      <div
        className="flex w-[min(1080px,94vw)] flex-col overflow-hidden rounded-xl border border-[#27272a] bg-[#09090b] shadow-2xl"
        style={{ height: "min(860px, calc(100vh - 32px))", maxHeight: "calc(100vh - 32px)" }}
        role="dialog"
        aria-modal="true"
      >
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
            onClick={() => setImageStudioSetupGuideOpen(false)}
            className="text-[#a1a1aa] transition-colors hover:text-white"
            title={copy.close}
            aria-label={copy.close}
          >
            <IconClose className="h-4 w-4" />
          </button>
        </div>

        <div className="flex min-h-0 flex-1">
          <div className="flex w-52 shrink-0 flex-col gap-1 overflow-y-auto border-r border-[#27272a] bg-[#000000] p-2">
            <button
              type="button"
              data-testid="image-studio-settings-tab-local"
              onClick={() => setSection("local")}
              className={`rounded-md px-4 py-2.5 text-left text-[13px] font-medium transition-colors ${
                section === "local" ? "theme-bg shadow-sm text-white" : "text-[#a1a1aa] hover:bg-[#18181b] hover:text-[#e4e4e7]"
              }`}
            >
              <span className="flex items-center gap-2">
                <IconZap className="h-4 w-4" />
                {copy.local}
              </span>
              <span className="mt-1 block text-[11px] text-[#71717a]">{copy.localSectionDetail}</span>
            </button>
            <button
              type="button"
              data-testid="image-studio-settings-tab-web"
              onClick={() => setSection("web")}
              className={`rounded-md px-4 py-2.5 text-left text-[13px] font-medium transition-colors ${
                section === "web" ? "theme-bg shadow-sm text-white" : "text-[#a1a1aa] hover:bg-[#18181b] hover:text-[#e4e4e7]"
              }`}
            >
              <span className="flex items-center gap-2">
                <IconGlobe className="h-4 w-4" />
                {copy.web}
              </span>
              <span className="mt-1 block text-[11px] text-[#71717a]">{copy.webSectionDetail}</span>
            </button>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto bg-[#09090b] p-6 pb-8">
            <div className="space-y-5">
              <div className="rounded-md border border-[#27272a] bg-[#000000] px-4 py-3">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-[13px] font-bold text-[#e4e4e7]">{copy.providerStatus}</div>
                    <div className="mt-1 text-[12px] leading-relaxed text-[#71717a]">{section === "local" ? copy.localDesc : copy.webDesc}</div>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className={`rounded-full border px-2.5 py-1 text-[11px] font-semibold ${statusToneClass}`}>
                      {copy.stateLabel[statusKey]}
                    </span>
                    <span className="rounded-full border border-[#27272a] px-2.5 py-1 text-[11px] text-[#a1a1aa]">
                      {copy.active}: {activeProviderLabel}
                    </span>
                    {imageStudio.status.activeModel ? (
                      <span className="rounded-full border border-[#27272a] px-2.5 py-1 text-[11px] text-[#a1a1aa]">
                        {imageStudio.status.activeModel}
                      </span>
                    ) : null}
                  </div>
                </div>
                <div className="mt-3 rounded-md border border-[#27272a] bg-[#09090b] px-3 py-2 text-[12px] leading-relaxed text-[#a1a1aa]">
                  {sectionStatusMessage}
                </div>
                <div className="mt-3 flex flex-wrap gap-2">
                  <button
                    type="button"
                    data-testid="image-studio-settings-save"
                    onClick={() => section === "local" ? persistLocalSettings(false) : persistWebSettings({ activate: false })}
                    className={settingsSecondaryButtonClass}
                  >
                    <span className="inline-flex items-center gap-1.5">
                      <IconCheck className="h-3.5 w-3.5" />
                      {copy.save}
                    </span>
                  </button>
                  <button
                    type="button"
                    data-testid="image-studio-settings-check"
                    onClick={() => void runCheck(section === "local" ? "local_image_service" : "web_fallback")}
                    disabled={checkingProvider !== null}
                    className={settingsSecondaryButtonClass}
                  >
                    <span className="inline-flex items-center gap-1.5">
                      <IconRefresh className="h-3.5 w-3.5" />
                      {checkingProvider ? copy.checking : copy.check}
                    </span>
                  </button>
                  <button
                    type="button"
                    data-testid="image-studio-settings-set-active"
                    onClick={() => {
                      if (section === "local") {
                        persistLocalSettings(true);
                        return;
                      }
                      persistWebSettings({ activate: true, enabled: true });
                    }}
                    className={settingsAccentButtonClass}
                  >
                    {copy.setActive}
                  </button>
                </div>
              </div>

              {section === "local" ? (
                <div className="space-y-5">
                  <div className="flex items-center justify-between">
                    <h3 className="text-[13px] font-bold uppercase tracking-wider text-[#a1a1aa]">{copy.localRuntime}</h3>
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
                  </div>

                  <div className={settingsSectionRowClass}>
                    <div>
                      <label className="block text-[13px] font-bold text-[#e4e4e7]">{copy.localProvider}</label>
                      <p className="mt-1.5 text-[12px] leading-relaxed text-[#a1a1aa]">{copy.currentLocalHint}</p>
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
                      <input
                        data-testid="image-studio-local-model-input"
                        value={localModelDraft}
                        onChange={(event) => setLocalModelDraft(event.target.value)}
                        className={`${settingsInputClass} font-mono`}
                        spellCheck={false}
                        placeholder={language === "en" ? "Optional model id" : "可选 model id"}
                      />
                    </div>
                  </div>

                  <div className={`${settingsSectionRowClass} border-t border-[#27272a] pt-5`}>
                    <div>
                      <span className="block text-[13px] font-bold text-[#e4e4e7]">{copy.protocol}</span>
                    </div>
                    <div className={settingsControlColumnClass}>
                      <div className="rounded-md border border-[#27272a] bg-[#000000] px-3 py-2.5 text-[13px] text-[#a1a1aa]">
                        {copy.protocolValue}
                      </div>
                    </div>
                  </div>

                  <div className={`${settingsSectionRowClass} border-t border-[#27272a] pt-5`}>
                    <div>
                      <span className="block text-[13px] font-bold text-[#e4e4e7]">{copy.discoveredModels}</span>
                      <p className="mt-1.5 text-[12px] leading-relaxed text-[#a1a1aa]">{copy.localHint}</p>
                    </div>
                    <div className={settingsControlColumnClass}>
                      {localDiscoveredModels.length > 0 ? (
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
                      ) : (
                        <div className="rounded-md border border-[#27272a] bg-[#000000] px-3 py-2 text-[12px] text-[#71717a]">
                          {copy.localEmpty}
                        </div>
                      )}
                    </div>
                  </div>

                  <div className={`${settingsSectionRowClass} border-t border-[#27272a] pt-5`}>
                    <div>
                      <span className="block text-[13px] font-bold text-[#e4e4e7]">{language === "en" ? "Network Guardrails" : "网络边界"}</span>
                    </div>
                    <div className={`${settingsControlColumnClass} rounded-lg border border-[#27272a] bg-[#000000] px-4 py-3`}>
                      <div className="text-[12px] leading-relaxed text-[#a1a1aa]">{copy.localHintSecondary}</div>
                    </div>
                  </div>
                </div>
              ) : (
                <div className="space-y-5">
                  <div className="flex items-center justify-between">
                    <h3 className="text-[13px] font-bold uppercase tracking-wider text-[#a1a1aa]">{copy.webRuntime}</h3>
                  </div>

                  <div className={settingsSectionRowClass}>
                    <div>
                      <label className="block text-[13px] font-bold text-[#e4e4e7]">{copy.endpoint}</label>
                    </div>
                    <div className={settingsControlColumnClass}>
                      <input
                        data-testid="image-studio-web-endpoint-input"
                        value={webEndpointDraft}
                        onChange={(event) => setWebEndpointDraft(event.target.value)}
                        className={`${settingsInputClass} font-mono`}
                        spellCheck={false}
                        placeholder={IMAGE_STUDIO_WEB_FALLBACK_ENDPOINT}
                      />
                    </div>
                  </div>

                  <div className={`${settingsSectionRowClass} border-t border-[#27272a] pt-5`}>
                    <div>
                      <span className="block text-[13px] font-bold text-[#e4e4e7]">{copy.promptRefine}</span>
                    </div>
                    <div className={`${settingsControlColumnClass} flex items-center justify-between rounded-lg border border-[#27272a] bg-[#000000] px-4 py-3`}>
                      <span className={`min-w-0 text-[12px] font-bold ${imageStudio.config.web.promptRefine ? "theme-text" : "text-[#a1a1aa]"}`}>
                        {imageStudio.config.web.promptRefine ? copy.enabled : copy.disabled}
                      </span>
                      <button
                        type="button"
                        role="switch"
                        aria-checked={imageStudio.config.web.promptRefine}
                        data-testid="image-studio-web-refine-switch"
                        aria-label={copy.promptRefine}
                        onClick={() => setImageStudioConfig({
                          web: {
                            ...imageStudio.config.web,
                            promptRefine: !imageStudio.config.web.promptRefine,
                          },
                        })}
                        className={`relative inline-flex h-6 w-11 items-center rounded-full border p-0.5 transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[#000000] ${
                          imageStudio.config.web.promptRefine
                            ? "border-transparent shadow-[0_0_12px_var(--accent-subtle)]"
                            : "border-[#3f3f46] bg-[#18181b]"
                        }`}
                        style={imageStudio.config.web.promptRefine ? { backgroundColor: "var(--accent)" } : undefined}
                      >
                        <span
                          className={`block h-5 w-5 rounded-full bg-white shadow-sm transition-transform duration-200 ${
                            imageStudio.config.web.promptRefine ? "translate-x-5" : "translate-x-0"
                          }`}
                        />
                      </button>
                    </div>
                  </div>

                  <div className={`${settingsSectionRowClass} border-t border-[#27272a] pt-5`}>
                    <div>
                      <span className="block text-[13px] font-bold text-[#e4e4e7]">{copy.webEnabled}</span>
                      <p className="mt-1.5 text-[12px] leading-relaxed text-[#a1a1aa]">{copy.webHint}</p>
                    </div>
                    <div className={`${settingsControlColumnClass} flex items-center justify-between rounded-lg border border-[#27272a] bg-[#000000] px-4 py-3`}>
                      <span className={`min-w-0 text-[12px] font-bold ${imageStudio.config.web.enabled ? "theme-text" : "text-[#a1a1aa]"}`}>
                        {imageStudio.config.web.enabled ? copy.enabled : copy.disabled}
                      </span>
                      <button
                        type="button"
                        role="switch"
                        aria-checked={imageStudio.config.web.enabled}
                        data-testid="image-studio-web-enabled-switch"
                        aria-label={copy.webEnabled}
                        onClick={toggleWebEnabled}
                        className={`relative inline-flex h-6 w-11 items-center rounded-full border p-0.5 transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[#000000] ${
                          imageStudio.config.web.enabled
                            ? "border-transparent shadow-[0_0_12px_var(--accent-subtle)]"
                            : "border-[#3f3f46] bg-[#18181b]"
                        }`}
                        style={imageStudio.config.web.enabled ? { backgroundColor: "var(--accent)" } : undefined}
                      >
                        <span
                          className={`block h-5 w-5 rounded-full bg-white shadow-sm transition-transform duration-200 ${
                            imageStudio.config.web.enabled ? "translate-x-5" : "translate-x-0"
                          }`}
                        />
                      </button>
                    </div>
                  </div>

                  <div className={`${settingsSectionRowClass} border-t border-[#27272a] pt-5`}>
                    <div>
                      <span className="block text-[13px] font-bold text-[#e4e4e7]">{language === "en" ? "Fallback Behavior" : "Fallback 行为"}</span>
                    </div>
                    <div className={`${settingsControlColumnClass} rounded-lg border border-[#27272a] bg-[#000000] px-4 py-3`}>
                      <div className="text-[12px] leading-relaxed text-[#a1a1aa]">
                        {copy.webStatusIdle}
                      </div>
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
