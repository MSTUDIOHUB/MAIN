import { useEffect, useMemo, useRef } from "react";
import { createPortal } from "react-dom";
import type { CSSProperties } from "react";
import type { ProjectInitPreview } from "../lib/projectInit";

export type ProjectInitReviewPhase =
  | "loading"
  | "review"
  | "committing"
  | "success"
  | "error";

export interface ProjectInitReviewModalProps {
  language: "zh" | "en";
  themeMode: "light" | "dark" | "black";
  phase: ProjectInitReviewPhase;
  preview: ProjectInitPreview | null;
  errorMessage?: string | null;
  onConfirm: () => void | Promise<void>;
  onCancel: () => void;
  onRegenerate: () => void | Promise<void>;
}

type PreviewStatus = ProjectInitPreview["status"];
type DiffTone = "added" | "removed" | "hunk" | "header" | "context";

const KNOWN_ERROR_CODES = [
  "PROJECT_INIT_WORKSPACE_STALE",
  "PROJECT_INIT_TARGET_STALE",
  "PROJECT_INIT_CONTENT_STALE",
  "PROJECT_INIT_TARGET_SYMLINK",
  "PROJECT_INIT_TARGET_TOO_LARGE",
  "PROJECT_INIT_TARGET_NOT_UTF8",
  "PROJECT_INIT_TARGET_INVALID",
  "PROJECT_INIT_TARGET_IDENTITY_CHANGED",
  "PROJECT_INIT_TARGET_UNAVAILABLE",
  "PROJECT_INIT_CONTENT_TOO_LARGE",
  "PROJECT_INIT_WRITE_FAILED",
] as const;

type KnownErrorCode = (typeof KNOWN_ERROR_CODES)[number];

function readErrorCode(errorMessage: string | null | undefined): KnownErrorCode | null {
  if (!errorMessage) return null;
  return KNOWN_ERROR_CODES.find((code) => errorMessage.includes(code)) ?? null;
}

export function localizeProjectInitReviewError(
  errorMessage: string | null | undefined,
  language: "zh" | "en",
): string {
  const code = readErrorCode(errorMessage);
  const messages: Record<KnownErrorCode, { zh: string; en: string }> = {
    PROJECT_INIT_WORKSPACE_STALE: {
      zh: "当前工作区已经切换。请重新生成预览后再确认。",
      en: "The active workspace changed. Regenerate the preview before confirming.",
    },
    PROJECT_INIT_TARGET_STALE: {
      zh: "AGENTS.md 的文件位置在审阅后发生了变化。请重新生成预览。",
      en: "The AGENTS.md file location changed after review. Regenerate the preview.",
    },
    PROJECT_INIT_CONTENT_STALE: {
      zh: "AGENTS.md 在审阅后已被修改。MAIN 没有覆盖这些更改，请重新生成预览。",
      en: "AGENTS.md changed after review. MAIN did not overwrite those changes; regenerate the preview.",
    },
    PROJECT_INIT_TARGET_SYMLINK: {
      zh: "AGENTS.md 是符号链接。为避免写到工作区之外，MAIN 已拒绝修改。",
      en: "AGENTS.md is a symbolic link. MAIN refused the change to avoid writing outside the workspace.",
    },
    PROJECT_INIT_TARGET_TOO_LARGE: {
      zh: "现有 AGENTS.md 太大，无法安全生成预览。",
      en: "The existing AGENTS.md is too large to preview safely.",
    },
    PROJECT_INIT_TARGET_NOT_UTF8: {
      zh: "AGENTS.md 不是 UTF-8 文本，无法安全更新。",
      en: "AGENTS.md is not UTF-8 text and cannot be updated safely.",
    },
    PROJECT_INIT_TARGET_INVALID: {
      zh: "AGENTS.md 不是普通文件，无法安全更新。",
      en: "AGENTS.md is not a regular file and cannot be updated safely.",
    },
    PROJECT_INIT_TARGET_IDENTITY_CHANGED: {
      zh: "AGENTS.md 的真实路径与审阅目标不一致。请检查工作区后重试。",
      en: "The resolved AGENTS.md path no longer matches the reviewed target. Check the workspace and try again.",
    },
    PROJECT_INIT_TARGET_UNAVAILABLE: {
      zh: "暂时无法读取 AGENTS.md。请检查文件权限后重试。",
      en: "AGENTS.md cannot be read right now. Check its permissions and try again.",
    },
    PROJECT_INIT_CONTENT_TOO_LARGE: {
      zh: "生成的 AGENTS.md 超出安全写入上限。请缩小项目概览后重试。",
      en: "The generated AGENTS.md exceeds the safe write limit. Reduce the project overview and try again.",
    },
    PROJECT_INIT_WRITE_FAILED: {
      zh: "写入 AGENTS.md 失败。现有文件没有被静默覆盖，请重试。",
      en: "AGENTS.md could not be written. The existing file was not silently overwritten; try again.",
    },
  };

  if (code) return messages[code][language];
  return language === "en"
    ? "MAIN could not complete project initialization. Regenerate the preview and try again."
    : "MAIN 无法完成项目初始化。请重新生成预览后重试。";
}

function getDiffTone(line: string): DiffTone {
  if (line.startsWith("@@")) return "hunk";
  if (line.startsWith("---") || line.startsWith("+++")) return "header";
  if (line.startsWith("+")) return "added";
  if (line.startsWith("-")) return "removed";
  return "context";
}

function statusLabel(
  phase: ProjectInitReviewPhase,
  status: PreviewStatus | null,
  language: "zh" | "en",
): string {
  const isEnglish = language === "en";
  if (phase === "loading") return isEnglish ? "Generating preview" : "正在生成预览";
  if (phase === "committing") return isEnglish ? "Writing AGENTS.md" : "正在写入 AGENTS.md";
  if (phase === "success") return isEnglish ? "Initialization complete" : "初始化完成";
  if (phase === "error") return isEnglish ? "Preview needs attention" : "预览需要处理";

  switch (status) {
    case "ready_create":
    case "ready_update":
      return isEnglish ? "Ready for review" : "可以审阅";
    case "already_initialized":
      return isEnglish ? "Already initialized" : "项目已经初始化";
    case "no_changes":
      return isEnglish ? "No changes needed" : "无需更改";
    case "invalid_managed_block":
      return isEnglish ? "Managed section needs attention" : "托管区块需要处理";
    default:
      return isEnglish ? "Preparing preview" : "正在准备预览";
  }
}

function statusTone(
  phase: ProjectInitReviewPhase,
  status: PreviewStatus | null,
): "accent" | "success" | "warning" | "danger" {
  if (phase === "success") return "success";
  if (phase === "error" || status === "invalid_managed_block") return "danger";
  if (phase === "committing" || phase === "loading") return "warning";
  if (status === "already_initialized" || status === "no_changes") return "success";
  return "accent";
}

export default function ProjectInitReviewModal({
  language,
  themeMode,
  phase,
  preview,
  errorMessage,
  onConfirm,
  onCancel,
  onRegenerate,
}: ProjectInitReviewModalProps) {
  const cancelButtonRef = useRef<HTMLButtonElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const isEnglish = language === "en";
  const isLight = themeMode === "light";
  const isBlack = themeMode === "black";
  const status = preview?.status ?? null;
  const isReady = phase === "review" && (status === "ready_create" || status === "ready_update");
  const isNoChange = status === "already_initialized" || status === "no_changes";
  const isCommitting = phase === "committing";
  const isTerminal = phase === "success" || (phase === "review" && isNoChange);
  const canRegenerate = phase === "error" || (phase === "review" && status === "invalid_managed_block");
  const diffLines = useMemo(
    () => (preview?.unifiedDiff ? preview.unifiedDiff.split("\n") : []),
    [preview?.unifiedDiff],
  );

  const copy = isEnglish
    ? {
        eyebrow: "WORKSPACE INITIALIZATION",
        title: "Review project instructions",
        description: "MAIN will only write this reviewed AGENTS.md after you confirm.",
        workspace: "Captured workspace",
        target: "Target file",
        operation: "Operation",
        create: "Create",
        update: "Update",
        noWrite: "No write needed",
        fingerprint: "Baseline fingerprint",
        diff: "Proposed diff",
        emptyDiff: "There are no file changes to display.",
        loading: "Scanning bounded project metadata and preparing a deterministic preview…",
        success: "AGENTS.md is up to date. New turns can use the refreshed project instructions.",
        invalidBlock: "The managed markers in AGENTS.md are missing or ambiguous. MAIN will not guess which content it may replace.",
        confirm: "Confirm and write",
        committing: "Writing…",
        cancel: "Cancel",
        close: "Close",
        regenerate: "Regenerate preview",
      }
    : {
        eyebrow: "工作区初始化",
        title: "审阅项目说明",
        description: "只有在你确认后，MAIN 才会写入这份已经审阅的 AGENTS.md。",
        workspace: "已捕获的工作区",
        target: "目标文件",
        operation: "操作",
        create: "创建",
        update: "更新",
        noWrite: "无需写入",
        fingerprint: "基线指纹",
        diff: "拟议变更",
        emptyDiff: "没有需要展示的文件变更。",
        loading: "正在扫描有界的项目元数据，并生成确定性预览…",
        success: "AGENTS.md 已更新。后续回合可以使用刷新后的项目说明。",
        invalidBlock: "AGENTS.md 中的托管标记缺失或存在歧义。MAIN 不会猜测可以替换哪一段内容。",
        confirm: "确认并写入",
        committing: "正在写入…",
        cancel: "取消",
        close: "关闭",
        regenerate: "重新生成预览",
      };

  const palette = isLight
    ? {
        overlay: "rgba(15, 23, 42, 0.48)",
        shell: "#ffffff",
        header: "#f8fafc",
        panel: "#f8fafc",
        code: "#ffffff",
        border: "#d4d4d8",
        subtleBorder: "#e4e4e7",
        text: "#18181b",
        muted: "#52525b",
        faint: "#71717a",
        context: "#3f3f46",
        addedText: "#166534",
        addedBg: "rgba(22, 163, 74, 0.10)",
        removedText: "#991b1b",
        removedBg: "rgba(220, 38, 38, 0.09)",
        hunkText: "#1d4ed8",
        hunkBg: "rgba(37, 99, 235, 0.09)",
        dangerText: "#b91c1c",
        dangerBg: "#fef2f2",
        warningText: "#92400e",
        successText: "#166534",
        secondaryBg: "#ffffff",
      }
    : {
        overlay: "rgba(0, 0, 0, 0.78)",
        shell: isBlack ? "#000000" : "#09090b",
        header: isBlack ? "#050506" : "#0f1014",
        panel: isBlack ? "#050506" : "#111217",
        code: isBlack ? "#000000" : "#07080b",
        border: isBlack ? "#27272a" : "#303038",
        subtleBorder: isBlack ? "#202024" : "#27272f",
        text: "#f4f4f5",
        muted: "#b1b1bb",
        faint: "#8a8a95",
        context: "#d4d4d8",
        addedText: "#86efac",
        addedBg: "rgba(34, 197, 94, 0.12)",
        removedText: "#fca5a5",
        removedBg: "rgba(239, 68, 68, 0.12)",
        hunkText: "#93c5fd",
        hunkBg: "rgba(59, 130, 246, 0.13)",
        dangerText: "#fca5a5",
        dangerBg: "rgba(127, 29, 29, 0.24)",
        warningText: "#fcd34d",
        successText: "#86efac",
        secondaryBg: isBlack ? "#09090b" : "#18181b",
      };

  const currentStatusTone = statusTone(phase, status);
  const statusColor = currentStatusTone === "success"
    ? palette.successText
    : currentStatusTone === "danger"
      ? palette.dangerText
      : currentStatusTone === "warning"
        ? palette.warningText
        : isLight
          ? "var(--accent-hover)"
          : "var(--accent-light)";

  const shellStyle: CSSProperties = {
    color: palette.text,
    background: isLight
      ? "radial-gradient(circle at top right, var(--accent-subtle), transparent 46%), #ffffff"
      : isBlack
        ? "radial-gradient(circle at top right, var(--accent-subtle), transparent 42%), #000000"
        : "radial-gradient(circle at top right, var(--accent-subtle), transparent 44%), #09090b",
    borderColor: palette.border,
  };

  useEffect(() => {
    previousFocusRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    const frame = window.requestAnimationFrame(() => cancelButtonRef.current?.focus());
    return () => {
      window.cancelAnimationFrame(frame);
      const previous = previousFocusRef.current;
      if (previous?.isConnected) previous.focus();
    };
  }, []);

  useEffect(() => {
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || isCommitting) return;
      event.preventDefault();
      event.stopPropagation();
      onCancel();
    };
    document.addEventListener("keydown", handleEscape, true);
    return () => document.removeEventListener("keydown", handleEscape, true);
  }, [isCommitting, onCancel]);

  if (typeof document === "undefined") return null;

  const operationLabel = isNoChange
    ? copy.noWrite
    : status === "ready_update"
      ? copy.update
      : status === "ready_create"
        ? copy.create
        : preview?.existing
          ? copy.update
          : copy.create;
  const workspaceLabel = preview?.canonicalWorkspace || preview?.workspaceIdentity || "—";
  const targetLabel = preview?.targetPath || "AGENTS.md";
  const fingerprintLabel = preview?.baselineFingerprint || "—";
  const showError = phase === "error" || status === "invalid_managed_block";
  const errorText = status === "invalid_managed_block"
    ? copy.invalidBlock
    : localizeProjectInitReviewError(errorMessage, language);

  return createPortal(
    <div
      data-testid="project-init-review-modal"
      data-theme-mode={themeMode}
      className="fixed inset-0 z-[140] flex items-center justify-center p-4 backdrop-blur-sm"
      style={{ backgroundColor: palette.overlay }}
    >
      <section
        data-testid="project-init-review-dialog"
        className="flex max-h-[calc(100vh-2rem)] w-[min(940px,96vw)] flex-col overflow-hidden rounded-2xl border shadow-2xl"
        style={shellStyle}
        role="dialog"
        aria-modal="true"
        aria-labelledby="project-init-review-title"
        aria-describedby="project-init-review-description"
        aria-busy={phase === "loading" || isCommitting}
      >
        <header
          className="flex shrink-0 items-start justify-between gap-5 border-b px-5 py-4 sm:px-6"
          style={{ borderColor: palette.border, backgroundColor: palette.header }}
        >
          <div className="min-w-0">
            <p
              className="text-[10px] font-semibold uppercase tracking-[0.18em]"
              style={{ color: isLight ? "var(--accent-hover)" : "var(--accent-light)" }}
            >
              {copy.eyebrow}
            </p>
            <h2 id="project-init-review-title" className="mt-1 text-[18px] font-semibold" style={{ color: palette.text }}>
              {copy.title}
            </h2>
            <p id="project-init-review-description" className="mt-1 text-[12px] leading-relaxed" style={{ color: palette.muted }}>
              {copy.description}
            </p>
          </div>
          <div
            data-testid="project-init-review-status"
            className="flex shrink-0 items-center gap-2 rounded-full border px-3 py-1.5 text-[11px] font-medium"
            style={{ borderColor: palette.subtleBorder, color: statusColor, backgroundColor: palette.panel }}
          >
            <span
              aria-hidden="true"
              className={`h-1.5 w-1.5 rounded-full ${phase === "loading" || isCommitting ? "animate-pulse" : ""}`}
              style={{ backgroundColor: statusColor }}
            />
            {statusLabel(phase, status, language)}
          </div>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4 sm:px-6">
          <div
            className="grid gap-px overflow-hidden rounded-xl border sm:grid-cols-3"
            style={{ borderColor: palette.subtleBorder, backgroundColor: palette.subtleBorder }}
          >
            <div className="min-w-0 p-3" style={{ backgroundColor: palette.panel }}>
              <div className="text-[10px] font-semibold uppercase tracking-[0.12em]" style={{ color: palette.faint }}>
                {copy.workspace}
              </div>
              <div
                data-testid="project-init-review-workspace"
                className="mt-1 truncate font-mono text-[11px]"
                style={{ color: palette.text }}
                title={String(workspaceLabel)}
              >
                {String(workspaceLabel)}
              </div>
            </div>
            <div className="min-w-0 p-3" style={{ backgroundColor: palette.panel }}>
              <div className="text-[10px] font-semibold uppercase tracking-[0.12em]" style={{ color: palette.faint }}>
                {copy.target}
              </div>
              <div
                data-testid="project-init-review-target"
                className="mt-1 truncate font-mono text-[11px]"
                style={{ color: palette.text }}
                title={String(targetLabel)}
              >
                {String(targetLabel)}
              </div>
            </div>
            <div className="min-w-0 p-3" style={{ backgroundColor: palette.panel }}>
              <div className="text-[10px] font-semibold uppercase tracking-[0.12em]" style={{ color: palette.faint }}>
                {copy.operation}
              </div>
              <div data-testid="project-init-review-operation" className="mt-1 text-[11px] font-medium" style={{ color: statusColor }}>
                {operationLabel}
              </div>
            </div>
          </div>

          <div
            className="mt-3 rounded-xl border px-3 py-2.5"
            style={{ borderColor: palette.subtleBorder, backgroundColor: palette.panel }}
          >
            <div className="text-[10px] font-semibold uppercase tracking-[0.12em]" style={{ color: palette.faint }}>
              {copy.fingerprint}
            </div>
            <div
              data-testid="project-init-review-fingerprint"
              className="mt-1 break-all font-mono text-[10px] leading-relaxed"
              style={{ color: palette.muted }}
              title={String(fingerprintLabel)}
            >
              {String(fingerprintLabel)}
            </div>
          </div>

          {phase === "loading" && (
            <div
              data-testid="project-init-review-loading"
              className="mt-4 flex min-h-48 flex-col items-center justify-center rounded-xl border px-6 text-center"
              style={{ borderColor: palette.subtleBorder, backgroundColor: palette.panel }}
              role="status"
            >
              <span
                aria-hidden="true"
                className="h-6 w-6 animate-spin rounded-full border-2 border-transparent"
                style={{ borderTopColor: "var(--accent)", borderRightColor: "var(--accent)" }}
              />
              <p className="mt-3 max-w-md text-[12px] leading-relaxed" style={{ color: palette.muted }}>
                {copy.loading}
              </p>
            </div>
          )}

          {showError && (
            <div
              data-testid="project-init-review-error"
              className="mt-4 rounded-xl border px-4 py-3 text-[12px] leading-relaxed"
              style={{ borderColor: palette.dangerText, backgroundColor: palette.dangerBg, color: palette.dangerText }}
              role="alert"
            >
              {errorText}
            </div>
          )}

          {phase === "success" && (
            <div
              data-testid="project-init-review-success"
              className="mt-4 rounded-xl border px-4 py-3 text-[12px] leading-relaxed"
              style={{ borderColor: palette.successText, backgroundColor: palette.panel, color: palette.successText }}
              role="status"
            >
              {copy.success}
            </div>
          )}

          {phase !== "loading" && (
            <div className="mt-4">
              <div className="mb-2 flex items-center justify-between gap-3">
                <h3 className="text-[11px] font-semibold uppercase tracking-[0.12em]" style={{ color: palette.faint }}>
                  {copy.diff}
                </h3>
                {preview?.refresh && (
                  <span
                    data-testid="project-init-review-refresh-badge"
                    className="rounded-full border px-2 py-0.5 text-[10px] font-medium"
                    style={{ borderColor: palette.subtleBorder, color: statusColor }}
                  >
                    --refresh
                  </span>
                )}
              </div>
              <div
                data-testid="project-init-review-diff"
                className="max-h-[42vh] min-h-40 overflow-auto rounded-xl border font-mono text-[11px] leading-5"
                style={{ borderColor: palette.subtleBorder, backgroundColor: palette.code }}
                aria-label={copy.diff}
              >
                {diffLines.length === 0 ? (
                  <div className="flex min-h-40 items-center justify-center px-4 text-center font-sans text-[12px]" style={{ color: palette.faint }}>
                    {copy.emptyDiff}
                  </div>
                ) : (
                  <code className="block min-w-max py-2">
                    {diffLines.map((line, index) => {
                      const tone = getDiffTone(line);
                      const toneStyle: CSSProperties = tone === "added"
                        ? { color: palette.addedText, backgroundColor: palette.addedBg }
                        : tone === "removed"
                          ? { color: palette.removedText, backgroundColor: palette.removedBg }
                          : tone === "hunk" || tone === "header"
                            ? { color: palette.hunkText, backgroundColor: palette.hunkBg }
                            : { color: palette.context };
                      return (
                        <span
                          key={`${index}:${line}`}
                          data-testid="project-init-review-diff-line"
                          data-diff-tone={tone}
                          className="block whitespace-pre px-3"
                          style={toneStyle}
                        >
                          {line || " "}
                        </span>
                      );
                    })}
                  </code>
                )}
              </div>
            </div>
          )}
        </div>

        <footer
          className="flex shrink-0 items-center justify-end gap-2 border-t px-5 py-3 sm:px-6"
          style={{ borderColor: palette.border, backgroundColor: palette.header }}
        >
          {isTerminal ? (
            <button
              ref={cancelButtonRef}
              type="button"
              data-testid="project-init-review-close"
              onClick={onCancel}
              className="theme-bg theme-bg-hover rounded-lg px-4 py-2 text-[12px] font-semibold outline-none transition-opacity focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-2"
              style={{ color: "var(--accent-contrast, #ffffff)" }}
            >
              {copy.close}
            </button>
          ) : (
            <>
              <button
                ref={cancelButtonRef}
                type="button"
                data-testid="project-init-review-cancel"
                onClick={onCancel}
                disabled={isCommitting}
                className="rounded-lg border px-4 py-2 text-[12px] font-medium outline-none transition-opacity hover:opacity-80 focus-visible:ring-2 focus-visible:ring-[var(--accent)] disabled:cursor-not-allowed disabled:opacity-45"
                style={{ borderColor: palette.border, backgroundColor: palette.secondaryBg, color: palette.text }}
              >
                {copy.cancel}
              </button>
              {canRegenerate && (
                <button
                  type="button"
                  data-testid="project-init-review-regenerate"
                  onClick={onRegenerate}
                  className="theme-bg theme-bg-hover rounded-lg px-4 py-2 text-[12px] font-semibold outline-none transition-opacity focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-2"
                  style={{ color: "var(--accent-contrast, #ffffff)" }}
                >
                  {copy.regenerate}
                </button>
              )}
              {(isReady || isCommitting) && (
                <button
                  type="button"
                  data-testid="project-init-review-confirm"
                  onClick={onConfirm}
                  disabled={!isReady || isCommitting}
                  className="theme-bg theme-bg-hover rounded-lg px-4 py-2 text-[12px] font-semibold outline-none transition-opacity focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
                  style={{ color: "var(--accent-contrast, #ffffff)" }}
                >
                  {isCommitting ? copy.committing : copy.confirm}
                </button>
              )}
            </>
          )}
        </footer>
      </section>
    </div>,
    document.body,
  );
}
