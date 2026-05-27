// @ts-nocheck
import React, { useEffect, useMemo, useState } from "react";
import { IconExternalLink, IconImageIcon, IconRefresh, IconSave, IconZap } from "./Icons";
import { openImageStudioOutput, readAttachmentImageDataUrl } from "../lib/ipc";
import { useAppStore } from "../store/useAppStore";

export default function ImageGenerationCard({
  block,
  language,
  onRegenerate,
}: {
  block: any;
  language: "zh" | "en";
  onRegenerate?: (prompt: string) => void;
}) {
  const [restoredImageUrl, setRestoredImageUrl] = useState("");
  const themeMode = useAppStore((s) => s.config.themeMode);
  const isLight = themeMode === "light";
  const copy = useMemo(() => ({
    queued: language === "en" ? "Queued" : "排队中",
    running: language === "en" ? "Generating" : "生成中",
    completed: language === "en" ? "Completed" : "已完成",
    error: language === "en" ? "Error" : "错误",
    canceled: language === "en" ? "Canceled" : "已取消",
    prompt: language === "en" ? "Prompt" : "提示词",
    params: language === "en" ? "Params" : "参数",
    output: language === "en" ? "Output" : "输出",
    open: language === "en" ? "Open image" : "打开图片",
    copyPrompt: language === "en" ? "Copy prompt" : "复制提示词",
    regenerate: language === "en" ? "Regenerate" : "重新生成",
    waiting: language === "en" ? "Waiting for the image engine" : "等待图像引擎返回结果",
  }), [language]);

  useEffect(() => {
    if (block.imageUrl || !block.outputPath) return;
    let canceled = false;
    readAttachmentImageDataUrl(block.outputPath)
      .then((dataUrl) => {
        if (!canceled) setRestoredImageUrl(dataUrl);
      })
      .catch(() => {
        if (!canceled) setRestoredImageUrl("");
      });
    return () => {
      canceled = true;
    };
  }, [block.imageUrl, block.outputPath]);

  const statusLabel = copy[block.status] || block.status;
  const progress = block.progress || {};
  const percent = Math.max(0, Math.min(100, Number(progress.percent) || 0));
  const imageUrl = block.imageUrl || restoredImageUrl || block.previewUrl || "";
  const isFinished = block.status === "completed";
  const isError = block.status === "error";
  const isHosted = block.params?.engine === "huggingface_space";
  const shellStyle = {
    backgroundColor: isLight ? "#ffffff" : "#09090b",
    borderColor: isLight ? "#d4d4d8" : "#27272a",
    color: isLight ? "#18181b" : "#e4e4e7",
  };
  const panelStyle = {
    backgroundColor: isLight ? "#f8fafc" : "#050507",
    borderColor: isLight ? "#d4d4d8" : "#27272a",
  };
  const mutedStyle = { color: isLight ? "#52525b" : "#a1a1aa" };
  const titleStyle = { color: isLight ? "#111827" : "#f4f4f5" };

  return (
    <div data-testid="image-generation-card" className="w-full overflow-hidden rounded-lg border" style={shellStyle}>
      <div className="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3" style={{ borderColor: shellStyle.borderColor }}>
        <div className="flex min-w-0 items-center gap-2">
          <div className="flex h-7 w-7 items-center justify-center rounded-md border border-[var(--accent-subtle-border)] bg-[var(--accent-subtle)] text-[var(--accent-light)]">
            <IconImageIcon className="h-3.5 w-3.5" />
          </div>
          <div className="min-w-0">
            <div className="text-[13px] font-semibold" style={titleStyle}>{language === "en" ? "Image Studio" : "图像工作室"}</div>
            <div className="truncate text-[11px]" style={mutedStyle}>{statusLabel}</div>
          </div>
        </div>
        <div className="flex items-center gap-2 text-[11px]" style={mutedStyle}>
          <IconZap className="h-3.5 w-3.5 text-[var(--accent-light)]" />
          <span>{progress.message || statusLabel}</span>
        </div>
      </div>

      <div className="grid gap-4 p-4 md:grid-cols-[minmax(260px,0.78fr)_minmax(260px,1fr)]">
        <div className="space-y-3">
          <div>
            <div className="mb-1 text-[10px] font-semibold uppercase tracking-[0.16em]" style={mutedStyle}>{copy.prompt}</div>
            <div className="whitespace-pre-wrap break-words rounded-md border p-3 text-[12px] leading-relaxed" style={{ ...panelStyle, color: isLight ? "#111827" : "#d4d4d8" }}>
              {block.prompt}
            </div>
          </div>
          <div>
            <div className="mb-1 text-[10px] font-semibold uppercase tracking-[0.16em]" style={mutedStyle}>{copy.params}</div>
            <div className="grid grid-cols-2 gap-2 text-[11px]" style={mutedStyle}>
              <span className="rounded-md border px-2 py-1" style={panelStyle}>{isHosted ? "HF Space" : `${block.params?.width} x ${block.params?.height}`}</span>
              <span className="rounded-md border px-2 py-1" style={panelStyle}>Seed {block.params?.seedMode === "random" ? "Random" : block.params?.seed}</span>
              <span className="rounded-md border px-2 py-1" style={panelStyle}>{block.params?.aspectRatio}</span>
              <span className="rounded-md border px-2 py-1" style={panelStyle}>{isHosted ? `Refine ${block.params?.promptRefine ? "On" : "Off"}` : `CFG ${block.params?.guidanceScale}`}</span>
            </div>
          </div>
          {block.error && (
            <div className="rounded-md border border-[rgba(248,113,113,0.3)] bg-[rgba(127,29,29,0.22)] p-3 text-[12px] leading-relaxed text-[#fca5a5]">
              {block.error}
            </div>
          )}
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => void navigator.clipboard?.writeText(block.prompt || "")}
              className="inline-flex h-8 items-center gap-1.5 rounded-md border px-3 text-[11px] transition-colors hover:bg-[#18181b] hover:text-white"
              style={{ borderColor: shellStyle.borderColor, color: isLight ? "#374151" : "#d4d4d8" }}
            >
              {copy.copyPrompt}
            </button>
            {block.outputPath && (
              <button
                type="button"
                data-testid="image-generation-open-output"
                onClick={() => void openImageStudioOutput(block.outputPath)}
                className="inline-flex h-8 items-center gap-1.5 rounded-md border px-3 text-[11px] transition-colors hover:bg-[#18181b] hover:text-white"
                style={{ borderColor: shellStyle.borderColor, color: isLight ? "#374151" : "#d4d4d8" }}
              >
                <IconExternalLink className="h-3.5 w-3.5" />
                {copy.open}
              </button>
            )}
            {onRegenerate && (
              <button
                type="button"
                onClick={() => onRegenerate(block.prompt)}
                className="inline-flex h-8 items-center gap-1.5 rounded-md border border-[var(--accent-subtle-border)] px-3 text-[11px] text-[var(--accent-light)] transition-colors hover:bg-[var(--accent-subtle)]"
              >
                <IconRefresh className="h-3.5 w-3.5" />
                {copy.regenerate}
              </button>
            )}
          </div>
        </div>

        <div className="min-w-0">
          <div className="mb-2 flex items-center justify-between gap-3">
            <div className="text-[10px] font-semibold uppercase tracking-[0.16em]" style={mutedStyle}>{copy.output}</div>
            <div className="text-[11px] tabular-nums" style={mutedStyle}>{Math.round(percent)}%</div>
          </div>
          <div className="mb-3 h-1.5 overflow-hidden rounded-full" style={{ backgroundColor: isLight ? "#e4e4e7" : "#18181b" }}>
            <div className="h-full rounded-full bg-[var(--accent)] transition-[width]" style={{ width: `${percent}%` }} />
          </div>
          <div className="flex aspect-square max-h-[520px] min-h-[260px] items-center justify-center overflow-hidden rounded-md border" style={panelStyle}>
            {imageUrl ? (
              <img
                src={imageUrl}
                alt={block.prompt || "generated image"}
                className={`h-full w-full object-contain transition-all duration-300 ${isFinished ? "blur-0" : "blur-[2px]"}`}
              />
            ) : (
              <div className="flex flex-col items-center gap-3 text-[#71717a]">
                <IconSave className="h-8 w-8 text-[#52525b]" />
                <span className="text-[12px]">{isError ? statusLabel : copy.waiting}</span>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
