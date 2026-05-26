// @ts-nocheck
import React, { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { IconCheck, IconClose, IconCode, IconImageIcon, IconRefresh, IconSettings, IconZap } from "./Icons";
import { useAppStore } from "../store/useAppStore";

export default function ImageStudioSetupModal() {
  const language = useAppStore((s) => s.config.language === "en" ? "en" : "zh");
  const themeMode = useAppStore((s) => s.config.themeMode);
  const imageStudio = useAppStore((s) => s.imageStudio);
  const setImageStudioConfig = useAppStore((s) => s.setImageStudioConfig);
  const setImageStudioSetupGuideOpen = useAppStore((s) => s.setImageStudioSetupGuideOpen);
  const checkImageStudioEngine = useAppStore((s) => s.checkImageStudioEngine);
  const [tab, setTab] = useState<"detect" | "connect" | "manual">("detect");
  const [endpointDraft, setEndpointDraft] = useState(imageStudio.config.endpoint);
  const [checking, setChecking] = useState(false);

  useEffect(() => {
    if (imageStudio.setupGuideOpen) {
      setEndpointDraft(imageStudio.config.endpoint);
    }
  }, [imageStudio.config.endpoint, imageStudio.setupGuideOpen]);

  const copy = useMemo(() => ({
    title: language === "en" ? "Image Studio Setup" : "图像工作室设置",
    subtitle: language === "en"
      ? "Connect MAIN to a running local or LAN image engine."
      : "把 MAIN 连接到正在运行的本机或局域网图像引擎。",
    detect: language === "en" ? "Auto Detect" : "自动检测",
    connect: language === "en" ? "Connect Service" : "连接已有服务",
    manual: language === "en" ? "HiDream Manual" : "手动配置 HiDream",
    endpoint: language === "en" ? "Endpoint" : "服务地址",
    test: language === "en" ? "Test Connection" : "测试连接",
    testing: language === "en" ? "Checking..." : "检测中...",
    close: language === "en" ? "Close" : "关闭",
    save: language === "en" ? "Save Endpoint" : "保存地址",
    ready: language === "en" ? "Ready" : "已就绪",
    missing: language === "en" ? "Not Connected" : "未连接",
    cudaTitle: language === "en" ? "CUDA Backend Required For V1" : "v1 按 CUDA 后端接入",
    cudaBody: language === "en"
      ? "HiDream-O1-Image official scripts currently assert CUDA availability and load the model with CUDA device mapping. Apple Silicon/MPS local inference should be treated as experimental and is not promised as out-of-the-box in this MAIN mode."
      : "HiDream-O1-Image 官方脚本当前会断言 CUDA 可用，并以 CUDA device map 加载模型。Apple Silicon/MPS 本机推理应视为实验路径，本版图像工作室不承诺开箱即用。",
    noInstall: language === "en"
      ? "MAIN v1 does not auto-download 15GB+ weights or create a PyTorch environment. Start your HiDream/ComfyUI HTTP service first, then connect it here."
      : "MAIN v1 不自动下载 15GB+ 权重，也不自动创建 PyTorch 环境。请先启动 HiDream/ComfyUI HTTP 服务，再在这里连接。",
  }), [language]);

  if (!imageStudio.setupGuideOpen || typeof document === "undefined") return null;

  const isLight = themeMode === "light";
  const panelStyle = {
    backgroundColor: isLight ? "#ffffff" : themeMode === "black" ? "#000000" : "#09090b",
    color: isLight ? "#18181b" : "#e4e4e7",
    borderColor: isLight ? "#d4d4d8" : "#27272a",
  };
  const mutedStyle = { color: isLight ? "#52525b" : "#a1a1aa" };
  const inputStyle = {
    backgroundColor: isLight ? "#f8fafc" : "#050507",
    borderColor: isLight ? "#d4d4d8" : "#27272a",
    color: isLight ? "#111827" : "#f4f4f5",
  };
  const statusTone = imageStudio.status.state === "ready"
    ? "border-[rgba(34,197,94,0.28)] bg-[rgba(34,197,94,0.10)] text-[#22c55e]"
    : imageStudio.status.state === "error"
    ? "border-[rgba(248,113,113,0.3)] bg-[rgba(127,29,29,0.18)] text-[#f87171]"
    : "border-[#3f3f46] bg-[#18181b] text-[#a1a1aa]";

  const runCheck = async () => {
    if (checking) return;
    setChecking(true);
    setImageStudioConfig({ endpoint: endpointDraft });
    try {
      await checkImageStudioEngine();
    } finally {
      setChecking(false);
    }
  };

  return createPortal(
    <div className="fixed inset-0 z-[120] flex items-center justify-center bg-black/55 px-4 py-6 backdrop-blur-sm">
      <div className="w-full max-w-3xl overflow-hidden rounded-xl border shadow-2xl" style={panelStyle} role="dialog" aria-modal="true">
        <div className="flex items-start justify-between gap-4 border-b px-5 py-4" style={{ borderColor: panelStyle.borderColor }}>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <div className="flex h-8 w-8 items-center justify-center rounded-md border border-[var(--accent-subtle-border)] bg-[var(--accent-subtle)] text-[var(--accent-light)]">
                <IconImageIcon className="h-4 w-4" />
              </div>
              <div className="text-[15px] font-semibold">{copy.title}</div>
              <span className={`rounded-full border px-2 py-0.5 text-[10px] ${statusTone}`}>
                {imageStudio.status.state === "ready" ? copy.ready : copy.missing}
              </span>
            </div>
            <div className="mt-1 text-[12px] leading-relaxed" style={mutedStyle}>{copy.subtitle}</div>
          </div>
          <button
            type="button"
            onClick={() => setImageStudioSetupGuideOpen(false)}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border transition-colors hover:bg-[#18181b]"
            style={{ borderColor: panelStyle.borderColor }}
            title={copy.close}
            aria-label={copy.close}
          >
            <IconClose className="h-4 w-4" />
          </button>
        </div>

        <div className="grid gap-0 md:grid-cols-[13rem_1fr]">
          <div className="border-b p-3 md:border-b-0 md:border-r" style={{ borderColor: panelStyle.borderColor }}>
            {[
              ["detect", copy.detect, IconRefresh],
              ["connect", copy.connect, IconSettings],
              ["manual", copy.manual, IconCode],
            ].map(([key, label, Icon]) => (
              <button
                key={key}
                type="button"
                onClick={() => setTab(key)}
                className="mb-1 flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-[12px] transition-colors"
                style={{
                  backgroundColor: tab === key ? "var(--accent-subtle)" : "transparent",
                  color: tab === key ? (isLight ? "var(--accent-hover)" : "var(--accent-light)") : undefined,
                }}
              >
                <Icon className="h-3.5 w-3.5" />
                {label}
              </button>
            ))}
          </div>

          <div className="space-y-4 p-5">
            {tab === "detect" && (
              <div className="space-y-4">
                <div className="rounded-lg border p-4" style={{ borderColor: panelStyle.borderColor, backgroundColor: isLight ? "#f8fafc" : "#050507" }}>
                  <div className="flex items-center gap-2 text-[13px] font-semibold">
                    <IconZap className="h-4 w-4 text-[var(--accent-light)]" />
                    {copy.detect}
                  </div>
                  <div className="mt-2 text-[12px] leading-relaxed" style={mutedStyle}>
                    {imageStudio.status.message || copy.noInstall}
                  </div>
                  <button
                    type="button"
                    onClick={runCheck}
                    disabled={checking}
                    className="mt-4 inline-flex h-8 items-center gap-2 rounded-md border border-[var(--accent-subtle-border)] px-3 text-[11px] font-semibold text-[var(--accent-light)] transition-colors hover:bg-[var(--accent-subtle)] disabled:opacity-60"
                  >
                    <IconRefresh className="h-3.5 w-3.5" />
                    {checking ? copy.testing : copy.test}
                  </button>
                </div>
                <div className="rounded-lg border border-[rgba(245,158,11,0.24)] bg-[rgba(245,158,11,0.08)] p-4">
                  <div className="text-[13px] font-semibold text-[#f59e0b]">{copy.cudaTitle}</div>
                  <div className="mt-2 text-[12px] leading-relaxed" style={mutedStyle}>{copy.cudaBody}</div>
                </div>
              </div>
            )}

            {tab === "connect" && (
              <div className="space-y-4">
                <label className="block">
                  <span className="mb-1 block text-[11px] font-semibold uppercase tracking-[0.14em]" style={mutedStyle}>{copy.endpoint}</span>
                  <input
                    value={endpointDraft}
                    onChange={(event) => setEndpointDraft(event.target.value)}
                    className="h-9 w-full rounded-md border px-3 text-[13px] outline-none focus:border-[var(--accent)]"
                    style={inputStyle}
                    spellCheck={false}
                  />
                </label>
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => setImageStudioConfig({ endpoint: endpointDraft })}
                    className="inline-flex h-8 items-center gap-2 rounded-md border border-[#27272a] px-3 text-[11px] transition-colors hover:bg-[#18181b]"
                  >
                    <IconCheck className="h-3.5 w-3.5" />
                    {copy.save}
                  </button>
                  <button
                    type="button"
                    onClick={runCheck}
                    disabled={checking}
                    className="inline-flex h-8 items-center gap-2 rounded-md border border-[var(--accent-subtle-border)] px-3 text-[11px] font-semibold text-[var(--accent-light)] transition-colors hover:bg-[var(--accent-subtle)] disabled:opacity-60"
                  >
                    <IconRefresh className="h-3.5 w-3.5" />
                    {checking ? copy.testing : copy.test}
                  </button>
                </div>
                <div className="text-[12px] leading-relaxed" style={mutedStyle}>{copy.noInstall}</div>
              </div>
            )}

            {tab === "manual" && (
              <div className="space-y-4">
                <div className="rounded-lg border p-4" style={{ borderColor: panelStyle.borderColor, backgroundColor: isLight ? "#f8fafc" : "#050507" }}>
                  <div className="text-[13px] font-semibold">{copy.cudaTitle}</div>
                  <div className="mt-2 text-[12px] leading-relaxed" style={mutedStyle}>{copy.cudaBody}</div>
                </div>
                <pre className="overflow-x-auto rounded-lg border p-4 text-[11px] leading-relaxed" style={{ borderColor: panelStyle.borderColor, backgroundColor: isLight ? "#f8fafc" : "#050507", color: isLight ? "#111827" : "#d4d4d8" }}>
{`git clone https://github.com/HiDream-ai/HiDream-O1-Image.git
cd HiDream-O1-Image
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
python app.py --host 127.0.0.1 --port 7860`}
                </pre>
                <div className="text-[12px] leading-relaxed" style={mutedStyle}>{copy.noInstall}</div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
