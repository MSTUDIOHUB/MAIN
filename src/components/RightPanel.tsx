import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  IconChevronDown,
  IconChevronRight,
  IconChevronUp,
  IconClose,
  IconColumns,
  IconFileText,
  IconRefresh,
  IconTerminal,
} from "./Icons";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { save } from "@tauri-apps/plugin-dialog";
import PlanPanel from "./PlanPanel";
import { buildLineDiff, getDiffStats } from "../lib/diff";
import { getE2EResumeExecutionHandler, getE2ESavePlanDocumentHandler } from "../lib/e2e";
import { extractPlanDraftPreview, extractStructuredPlanProposal, hasPlanDraftPreview, hasStructuredPlanProposal } from "../lib/planProposal";
import { resolveGlobalChatSessionKey, resolveSessionRuntimeKey, resolveSessionWorkspaceKey, type DiffRevertRequest, type TaskBlock, useAppStore } from "../store/useAppStore";
import { deleteChatTempPath, exportTextFile, getPtyStatus, onPtyData, readPtyBuffer, resizePty, spawnPty, writePty } from "../lib/ipc";
import { collectChangeEntries, isPlanConversationTurn, isPlanTaskTrustedComplete, type PlanArtifact, type PlanExecutionEvidenceEntry, type PlanTask } from "../lib/workflowModels";

const CODE_FONT_FAMILY = "'JetBrains Mono', 'Fira Code', Menlo, Monaco, 'Courier New', monospace";
const TERMINAL_FONT_FAMILY = [
  "'JetBrains Mono'",
  "'Fira Code'",
  "'SF Mono'",
  "Menlo",
  "Monaco",
  "Consolas",
  "'Liberation Mono'",
  "'Noto Sans Mono CJK SC'",
  "'Noto Sans CJK SC'",
  "'PingFang SC'",
  "'Microsoft YaHei UI'",
  "'Microsoft YaHei'",
  "'WenQuanYi Micro Hei'",
  "monospace",
].join(", ");

function buildTrustedResumePrompt(input: {
  language: "zh" | "en";
  hasTasksArtifact: boolean;
  tasks: PlanTask[];
  artifacts: PlanArtifact[];
  evidenceLedger: PlanExecutionEvidenceEntry[];
}): string {
  const remainingTasks = input.tasks.filter((task) => !isPlanTaskTrustedComplete(task)).slice(0, 8);
  const evidenceSummary = input.evidenceLedger.slice(-8).map((entry) => {
    const target = entry.target || entry.value;
    return `- ${entry.kind}:${target} (${entry.sourceTool})`;
  }).join("\n") || (input.language === "zh" ? "- 暂无可信执行证据" : "- No trusted execution evidence yet");
  const artifactSummary = input.artifacts.map((artifact) => `- ${artifact.path} (${artifact.kind}, ${artifact.content.length} chars)`).join("\n") ||
    (input.language === "zh" ? "- 暂无计划文件摘要" : "- No plan artifact summary");
  const remainingText = remainingTasks.map((task, index) => {
    const evidence = task.evidence?.map((item) => `${item.kind}:${item.value}`).join(", ") || (input.language === "zh" ? "无证据标签" : "no evidence tags");
    return `${index + 1}. ${task.text} [${task.evidenceStatus || "missing"}; ${evidence}]`;
  }).join("\n") || (input.language === "zh" ? "无剩余任务；请核查 tasks.md 是否需要生成。" : "No remaining tasks; verify whether tasks.md needs to be generated.");

  if (input.language === "zh") {
    return [
      "请在新的恢复上下文中继续执行计划，不要复用上一轮错误链路。",
      input.hasTasksArtifact
        ? "从 `.MAIN/plans/tasks.md` 中第一个证据未满足的任务开始。只有真实写入/命令成功/验证证据满足后，才可以把任务视为完成。"
        : "请先基于已批准的 requirements/design 或 bugfix 重新生成 `.MAIN/plans/tasks.md`，然后执行真实任务。",
      "不要重写已经满足证据的任务；不要只修改 checkbox；不要重复计划说明。",
      "",
      "计划文件摘要：",
      artifactSummary,
      "",
      "最近可信执行证据：",
      evidenceSummary,
      "",
      "优先恢复任务：",
      remainingText,
    ].join("\n");
  }

  return [
    "Continue plan execution in a fresh recovery context; do not reuse the previous errored loop.",
    input.hasTasksArtifact
      ? "Start from the first task whose evidence is not satisfied. Treat a task as complete only after real file-write, successful command, or verification evidence exists."
      : "First regenerate `.MAIN/plans/tasks.md` from the approved requirements/design or bugfix, then execute real tasks.",
    "Do not redo tasks whose evidence is already satisfied. Do not only edit checkboxes. Do not restate the plan.",
    "",
    "Plan artifact summary:",
    artifactSummary,
    "",
    "Recent trusted execution evidence:",
    evidenceSummary,
    "",
    "Priority recovery tasks:",
    remainingText,
  ].join("\n");
}

function sanitizeSuggestedFileName(input: string): string {
  const trimmed = input.trim() || "plan";
  return trimmed
    .replace(/[\\/:*?"<>|]+/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .toLowerCase();
}

const REVIEW_BINARY_EXTS = new Set([
  "exe", "dll", "so", "dylib", "bin", "dat",
  "zip", "tar", "gz", "rar", "7z", "bz2", "xz", "zst",
  "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx",
  "mp3", "mp4", "avi", "mov", "mkv", "wav", "flac", "ogg", "webm",
  "woff", "woff2", "ttf", "otf", "eot",
  "class", "jar", "war", "pyc", "o", "a",
]);

function getReviewFileExtension(path: string): string {
  const fileName = path.split("/").pop()?.toLowerCase() || path.toLowerCase();
  const dotIdx = fileName.lastIndexOf(".");
  return dotIdx === -1 ? "" : fileName.slice(dotIdx + 1);
}

function isBinaryFile(path: string): boolean {
  const fileName = path.split("/").pop()?.toLowerCase() || path.toLowerCase();
  if (fileName === "dockerfile" || fileName === "makefile") return false;
  return REVIEW_BINARY_EXTS.has(getReviewFileExtension(path));
}

function looksBinary(content: string): boolean {
  if (!content) return false;
  const sample = content.slice(0, 8192);
  let nonPrintable = 0;
  for (let i = 0; i < sample.length; i++) {
    const code = sample.charCodeAt(i);
    if (code === 0) return true;
    if (code < 8 || (code >= 14 && code < 32 && code !== 10 && code !== 13 && code !== 27)) {
      nonPrintable++;
    }
  }
  return nonPrintable / sample.length > 0.1;
}

function turnHasGeneratedPlan(blocks: any[]) {
  return blocks.some((block) => {
    if (block.type === "tool") {
      return /\.main\/plans\//i.test(String(block.target || ""));
    }

    if (block.type !== "agent") return false;
    const raw = String(block.content || "");
    return hasStructuredPlanProposal(raw) || hasPlanDraftPreview(raw);
  });
}

/** Integrated Terminal sub-component with xterm.js */
function IntegratedTerminal({
  themeMode,
  workspace,
  sessionKey,
}: {
  themeMode: "light" | "dark";
  workspace: string;
  sessionKey?: string;
}) {
  const termRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const ptyReadyRef = useRef<Promise<void> | null>(null);

  useEffect(() => {
    if (!termRef.current) return;

    const term = new Terminal({
      cursorBlink: true,
      cursorStyle: "block",
      fontSize: 13,
      fontFamily: TERMINAL_FONT_FAMILY,
      lineHeight: 1.25,
      letterSpacing: 0,
      scrollback: 5000,
      theme: themeMode === "light"
        ? {
            background: "#ffffff",
            foreground: "#18181b",
            cursor: "#18181b",
            cursorAccent: "#ffffff",
            selectionBackground: "#d4d4d8",
            black: "#18181b",
            red: "#dc2626",
            green: "#059669",
            yellow: "#ca8a04",
            blue: "#2563eb",
            magenta: "#9333ea",
            cyan: "#0891b2",
            white: "#52525b",
            brightBlack: "#71717a",
            brightRed: "#ef4444",
            brightGreen: "#10b981",
            brightYellow: "#eab308",
            brightBlue: "#3b82f6",
            brightMagenta: "#a855f7",
            brightCyan: "#06b6d4",
            brightWhite: "#09090b",
          }
        : {
            background: "#181818",
            foreground: "#d4d4d8",
            cursor: "#d4d4d8",
            cursorAccent: "#181818",
            selectionBackground: "#34343b",
            black: "#1d1d20",
            red: "#f48771",
            green: "#86d9a3",
            yellow: "#fbbf24",
            blue: "#6cb6ff",
            magenta: "#d2a8ff",
            cyan: "#56d4dd",
            white: "#d4d4d8",
            brightBlack: "#8c8c97",
            brightRed: "#f48771",
            brightGreen: "#86d9a3",
            brightYellow: "#fbbf24",
            brightBlue: "#6cb6ff",
            brightMagenta: "#d2a8ff",
            brightCyan: "#56d4dd",
            brightWhite: "#f4f4f5",
          },
      allowProposedApi: true,
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(termRef.current);
    fitAddon.fit();

    xtermRef.current = term;
    fitAddonRef.current = fitAddon;

    let disposed = false;
    let unlisten: (() => void) | null = null;
    let ptyKnownRunning = false;
    let statusCheckedAt = 0;
    let hasRenderedInitialBuffer = false;

    const writeSystemLine = (message: string, color = "90") => {
      term.writeln(`\x1b[${color}m# ${message}\x1b[0m`);
    };

    const terminalHasFocus = () => {
      const container = termRef.current;
      const active = document.activeElement;
      return !!container && !!active && container.contains(active);
    };

    const focusTerminalSoon = (force = false) => {
      if (disposed) return;
      if (!force && !terminalHasFocus()) return;
      requestAnimationFrame(() => {
        if (!disposed) term.focus();
      });
    };

    const subscribePtyData = async () => {
      if (unlisten) return;
      unlisten = await onPtyData((chunk) => {
        if (disposed) return;
        const shouldRefocus = terminalHasFocus();
        term.write(chunk);
        if (shouldRefocus) focusTerminalSoon();
      }, sessionKey);
    };

    const ensurePtyReady = (forceStatusCheck = false): Promise<void> => {
      if (ptyReadyRef.current) return ptyReadyRef.current;

      const checkedRecently = Date.now() - statusCheckedAt < 1_000;
      if (ptyKnownRunning && checkedRecently && !forceStatusCheck) {
        return Promise.resolve();
      }

      ptyReadyRef.current = (async () => {
        let shouldSpawn = false;
        let shouldReplayBuffer = !hasRenderedInitialBuffer;

        try {
          const status = await getPtyStatus(sessionKey);
          statusCheckedAt = Date.now();
          shouldSpawn = !status.active || !status.running;
        } catch {
          shouldSpawn = true;
        }

        if (shouldSpawn) {
          await spawnPty(Math.max(term.cols, 120), Math.max(term.rows, 32), sessionKey, workspace);
          ptyKnownRunning = true;
          statusCheckedAt = Date.now();
          shouldReplayBuffer = true;
        } else {
          ptyKnownRunning = true;
        }

        if (disposed) return;

        await subscribePtyData();

        if (disposed) {
          unlisten?.();
          unlisten = null;
          return;
        }

        if (shouldReplayBuffer) {
          const existingBuffer = await readPtyBuffer(undefined, sessionKey).catch(() => "");
          if (existingBuffer) {
            term.write(existingBuffer);
          } else {
            writeSystemLine("PTY connected");
          }
          hasRenderedInitialBuffer = true;
        }

        await resizePty(Math.max(term.cols, 20), Math.max(term.rows, 5), sessionKey).catch(() => {});
      })().catch((error) => {
        ptyKnownRunning = false;
        statusCheckedAt = 0;
        if (!disposed) {
          const message = error instanceof Error ? error.message : String(error);
          writeSystemLine(`PTY error: ${message}`, "31");
        }
        throw error;
      }).finally(() => {
        ptyReadyRef.current = null;
      });

      return ptyReadyRef.current;
    };

    const writeInputToPty = async (data: string) => {
      await ensurePtyReady();
      try {
        await writePty(data, sessionKey);
      } catch {
        ptyKnownRunning = false;
        statusCheckedAt = 0;
        await ensurePtyReady(true);
        await writePty(data, sessionKey);
      }
    };

    const syncTerminalSize = () => {
      try {
        fitAddon.fit();
      } catch {
        // ignore transient fit errors while the panel is resizing/unmounting
      }

      void ensurePtyReady()
        .then(() => resizePty(Math.max(term.cols, 20), Math.max(term.rows, 5), sessionKey))
        .catch(() => {});
    };

    void ensurePtyReady();
    focusTerminalSoon(true);

    const disposable = term.onData((data) => {
      void writeInputToPty(data).catch((error) => {
          if (disposed) return;
          const message = error instanceof Error ? error.message : String(error);
          writeSystemLine(`write failed: ${message}`, "31");
        });
    });

    const resizeObserver = new ResizeObserver(() => {
      syncTerminalSize();
    });
    resizeObserver.observe(termRef.current);

    return () => {
      disposed = true;
      disposable.dispose();
      resizeObserver.disconnect();
      unlisten?.();
      term.dispose();
      xtermRef.current = null;
      fitAddonRef.current = null;
      ptyReadyRef.current = null;
    };
  }, [sessionKey, themeMode, workspace]);

  const focusTerminal = () => {
    xtermRef.current?.focus();
  };

  const focusTerminalWhenSafe = () => {
    const container = termRef.current;
    const active = document.activeElement;
    if (!active || active === document.body || (container && container.contains(active))) {
      xtermRef.current?.focus();
    }
  };

  return (
    <div
      ref={termRef}
      data-testid="integrated-terminal"
      tabIndex={0}
      className="h-full w-full outline-none"
      onFocus={focusTerminal}
      onPointerDown={focusTerminal}
      onPointerEnter={focusTerminalWhenSafe}
    />
  );
}

type ToolDiffBlock = Extract<TaskBlock, { type: "tool" }>;

interface ReviewFileDiff {
  key: string;
  path: string;
  displayPath: string;
  oldText: string;
  newText: string;
  existed?: boolean;
  fullFile: boolean;
  canRevert: boolean;
  hasPendingReview: boolean;
  hasExecuted: boolean;
  revertStatus?: "reverting" | "reverted" | "failed";
  revertMessage?: string;
  added: number;
  removed: number;
  taskIds: number[];
  isBinaryLike: boolean;
  isPlanFile: boolean;
}

type ReviewRow =
  | { kind: "fold"; id: string; count: number }
  | { kind: "line"; id: string; type: "unchanged" | "removed" | "added"; oldLine?: number; newLine?: number; text: string };

function supportsFullFileRevert(block: ToolDiffBlock): boolean {
  if (!block.diff) return false;
  if (block.diff.fullFile === true) return true;
  if (block.diff.fullFile === false) return false;
  return block.toolName === "write_file";
}

function getReviewFileRevertStatus(blocks: ToolDiffBlock[]): ReviewFileDiff["revertStatus"] {
  const executedBlocks = blocks.filter((block) => block.toolStatus === "executed");
  if (executedBlocks.some((block) => block.revertStatus === "reverting")) return "reverting";
  if (executedBlocks.some((block) => block.revertStatus === "failed")) return "failed";
  if (executedBlocks.length > 0 && executedBlocks.every((block) => block.revertStatus === "reverted")) return "reverted";
  return undefined;
}

function collectReviewFileDiffs(taskFlow: TaskBlock[], activeDiffTask?: ToolDiffBlock | null): ReviewFileDiff[] {
  const diffBlocks = taskFlow.filter((block): block is ToolDiffBlock => block.type === "tool" && !!block.diff);
  const activeBlock = activeDiffTask?.diff ? activeDiffTask : null;
  const blocks = activeBlock && !diffBlocks.some((block) => block.id === activeBlock.id)
    ? [...diffBlocks, activeBlock]
    : diffBlocks;
  const byPath = new Map<string, ToolDiffBlock[]>();

  for (const block of blocks) {
    const path = block.diff?.path || block.target || (block.toolName ? `${block.toolName}-${block.id}` : `change-${block.id}`);
    byPath.set(path, [...(byPath.get(path) || []), block]);
  }

  return Array.from(byPath.entries()).map(([path, blocksForPath]) => {
    const first = blocksForPath[0];
    const last = blocksForPath[blocksForPath.length - 1];
    const oldText = first.diff?.old || "";
    const newText = last.diff?.new || "";
    const stats = getDiffStats(oldText, newText);
    const isBinaryLike = isBinaryFile(path) || looksBinary(oldText) || looksBinary(newText);
    const executedBlocks = blocksForPath.filter((block) => block.toolStatus === "executed");
    const hasPendingReview = blocksForPath.some((block) => block.toolStatus === "pending");
    const fullFile = executedBlocks.length > 0
      ? executedBlocks.every(supportsFullFileRevert)
      : blocksForPath.every(supportsFullFileRevert);
    const revertStatus = getReviewFileRevertStatus(blocksForPath);
    const revertMessage = [...blocksForPath]
      .reverse()
      .find((block) => block.revertMessage)?.revertMessage;

    return {
      key: path,
      path,
      displayPath: path,
      oldText,
      newText,
      existed: first.diff?.existed,
      fullFile,
      canRevert: hasPendingReview || (executedBlocks.length > 0 && fullFile && revertStatus !== "reverted"),
      hasPendingReview,
      hasExecuted: executedBlocks.length > 0,
      ...(revertStatus ? { revertStatus } : {}),
      ...(revertMessage ? { revertMessage } : {}),
      added: stats.added,
      removed: stats.removed,
      taskIds: blocksForPath.map((block) => block.id),
      isBinaryLike,
      isPlanFile: path.replace(/\\/g, "/").toLowerCase().includes(".main/plans/"),
    };
  }).sort((a, b) => {
    if (a.isPlanFile !== b.isPlanFile) return a.isPlanFile ? 1 : -1;
    return a.path.localeCompare(b.path);
  });
}

function buildReviewRows(oldText: string, newText: string, contextSize = 3): ReviewRow[] {
  const diffLines = buildLineDiff(oldText, newText);
  const rows: ReviewRow[] = [];
  let oldLine = 1;
  let newLine = 1;
  let unchangedBuffer: ReviewRow[] = [];
  let foldIndex = 0;

  const flushUnchanged = (atEdge: boolean) => {
    if (unchangedBuffer.length === 0) return;
    if (unchangedBuffer.length > contextSize * 2 + 2) {
      const headCount = atEdge && rows.length === 0 ? 0 : contextSize;
      const tailCount = atEdge ? 0 : contextSize;
      rows.push(...unchangedBuffer.slice(0, headCount));
      rows.push({
        kind: "fold",
        id: `fold-${foldIndex++}`,
        count: unchangedBuffer.length - headCount - tailCount,
      });
      if (tailCount > 0) rows.push(...unchangedBuffer.slice(-tailCount));
    } else {
      rows.push(...unchangedBuffer);
    }
    unchangedBuffer = [];
  };

  for (const line of diffLines) {
    if (line.type === "unchanged") {
      unchangedBuffer.push({
        kind: "line",
        id: `u-${oldLine}-${newLine}`,
        type: "unchanged",
        oldLine,
        newLine,
        text: line.text,
      });
      oldLine += 1;
      newLine += 1;
      continue;
    }

    flushUnchanged(false);
    if (line.type === "removed") {
      rows.push({ kind: "line", id: `r-${oldLine}-${rows.length}`, type: "removed", oldLine, text: line.text });
      oldLine += 1;
    } else {
      rows.push({ kind: "line", id: `a-${newLine}-${rows.length}`, type: "added", newLine, text: line.text });
      newLine += 1;
    }
  }

  flushUnchanged(true);
  return rows;
}

function DiffReviewPanel({ taskFlow, activeDiffTask, language }: { taskFlow: TaskBlock[]; activeDiffTask?: ToolDiffBlock | null; language: "zh" | "en" }) {
  const files = useMemo(() => collectReviewFileDiffs(taskFlow, activeDiffTask), [activeDiffTask, taskFlow]);
  const revertDiffGroups = useAppStore((s) => s.revertDiffGroups);
  const [collapsedFiles, setCollapsedFiles] = useState<Set<string>>(() => new Set());
  const [revertingKeys, setRevertingKeys] = useState<Set<string>>(() => new Set());

  useEffect(() => {
    setCollapsedFiles((prev) => {
      const validKeys = new Set(files.map((file) => file.key));
      const next = new Set(Array.from(prev).filter((key) => validKeys.has(key)));
      return next.size === prev.size ? prev : next;
    });
  }, [files]);

  const totals = useMemo(
    () => files.reduce((sum, file) => ({ added: sum.added + file.added, removed: sum.removed + file.removed }), { added: 0, removed: 0 }),
    [files],
  );
  const activeDiffTarget = activeDiffTask?.diff?.path || activeDiffTask?.target || "";
  const allCollapsed = files.length > 0 && files.every((file) => collapsedFiles.has(file.key));
  const toggleAll = () => setCollapsedFiles(allCollapsed ? new Set() : new Set(files.map((file) => file.key)));
  const revertableFiles = files.filter((file) => file.canRevert);
  const hasRevertingFile = files.some((file) => revertingKeys.has(file.key) || file.revertStatus === "reverting");
  const buildRevertRequest = (file: ReviewFileDiff): DiffRevertRequest => ({
    path: file.path,
    taskIds: file.taskIds,
    oldText: file.oldText,
    newText: file.newText,
    ...(typeof file.existed === "boolean" ? { existed: file.existed } : {}),
    fullFile: file.fullFile,
  });
  const handleRevertFiles = async (targets: ReviewFileDiff[]) => {
    const actionableTargets = targets.filter((file) => file.canRevert);
    if (actionableTargets.length === 0) return;
    const hasPending = actionableTargets.some((file) => file.hasPendingReview);
    const confirmMessage = language === "zh"
      ? actionableTargets.length === 1
        ? `${hasPending ? "拒绝" : "撤销"} ${actionableTargets[0].displayPath} 的修改？此操作会更新工作区文件。`
        : `撤销 ${actionableTargets.length} 个文件的修改？此操作会更新工作区文件。`
      : actionableTargets.length === 1
        ? `${hasPending ? "Reject" : "Revert"} changes to ${actionableTargets[0].displayPath}? This will update workspace files.`
        : `Revert changes to ${actionableTargets.length} files? This will update workspace files.`;
    if (!window.confirm(confirmMessage)) return;

    const keys = actionableTargets.map((file) => file.key);
    setRevertingKeys((prev) => new Set([...prev, ...keys]));
    try {
      await revertDiffGroups(actionableTargets.map(buildRevertRequest));
    } finally {
      setRevertingKeys((prev) => {
        const next = new Set(prev);
        keys.forEach((key) => next.delete(key));
        return next;
      });
    }
  };

  if (files.length === 0) {
    return (
      <div data-testid="diff-panel" className="flex h-full items-center justify-center bg-[#101010] px-6 text-center text-[13px] text-[#8f8f98]">
        {language === "zh" ? "当前会话暂无可查看的文件修改。" : "No file changes are available in this session."}
      </div>
    );
  }

  return (
    <div data-testid="diff-panel" className="flex h-full flex-col bg-[#101010] text-[#d4d4d8]">
      <div data-testid="diff-panel-title" className="flex shrink-0 items-center justify-between border-b border-[#252525] px-4 py-3">
        <div className="min-w-0 flex items-center gap-2">
          <span className="text-[18px] font-bold text-[#f4f4f5]">{language === "zh" ? "未暂存" : "Changes"}</span>
          <span className="rounded-full bg-[#2b2b2d] px-2.5 py-1 text-[12px] font-bold text-[#d4d4d8]">{files.length}</span>
          <span className="truncate font-mono text-[12px] text-[#34d399]">+{totals.added}</span>
          <span className="font-mono text-[12px] text-[#ff5c5c]">-{totals.removed}</span>
          {activeDiffTarget && (
            <span className="truncate font-mono text-[12px] text-[#a1a1aa]" title={activeDiffTarget}>{activeDiffTarget}</span>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {revertableFiles.length > 0 && (
            <button
              type="button"
              data-testid="diff-revert-all"
              disabled={hasRevertingFile}
              onClick={() => void handleRevertFiles(revertableFiles)}
              className="flex items-center gap-1.5 rounded-md border border-[#7f1d1d]/40 bg-[#1a0b0d] px-2.5 py-1 text-[11px] font-semibold text-[#fca5a5] transition-colors hover:border-[#ef4444]/45 hover:bg-[#2a1013] disabled:cursor-not-allowed disabled:opacity-50"
            >
              <IconRefresh className="h-3.5 w-3.5" />
              {language === "zh" ? "撤销全部" : "Revert all"}
            </button>
          )}
          <button
            type="button"
            onClick={toggleAll}
            className="rounded-md border border-[#2f2f32] bg-[#181818] px-2.5 py-1 text-[11px] text-[#a1a1aa] transition-colors hover:bg-[#242428] hover:text-[#f4f4f5]"
          >
            {allCollapsed ? (language === "zh" ? "展开全部" : "Expand all") : (language === "zh" ? "折叠全部" : "Collapse all")}
          </button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto pb-6">
        {files.map((file) => {
          const collapsed = collapsedFiles.has(file.key);
          const rows = file.isBinaryLike ? [] : buildReviewRows(file.oldText, file.newText);
          const isReverting = revertingKeys.has(file.key) || file.revertStatus === "reverting";
          const showRevertButton = file.canRevert || isReverting;
          const statusLabel =
            file.revertStatus === "reverted"
              ? language === "zh" ? "已撤销" : "Reverted"
              : file.revertStatus === "failed"
              ? language === "zh" ? "撤销失败" : "Revert failed"
              : isReverting
              ? language === "zh" ? "撤销中" : "Reverting"
              : "";
          return (
            <section key={file.key} className="border-b border-[#202020]">
              <div className="flex items-center justify-between gap-3 bg-[#101010] px-4 py-3 transition-colors hover:bg-[#181818]">
                <button
                  type="button"
                  onClick={() => setCollapsedFiles((prev) => {
                    const next = new Set(prev);
                    if (next.has(file.key)) next.delete(file.key);
                    else next.add(file.key);
                    return next;
                  })}
                  className="flex min-w-0 flex-1 items-center gap-2 text-left"
                >
                  {collapsed ? <IconChevronRight className="h-4 w-4 text-[#a1a1aa]" /> : <IconChevronUp className="h-4 w-4 text-[#a1a1aa]" />}
                  <span className="truncate font-mono text-[14px] font-bold text-[#f4f4f5]">{file.displayPath}</span>
                </button>
                <div className="flex shrink-0 items-center gap-2">
                  {statusLabel && (
                    <span
                      data-testid="diff-revert-status"
                      className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold ${
                        file.revertStatus === "failed"
                          ? "border-[#7f1d1d]/60 bg-[#2a1013] text-[#fca5a5]"
                          : "border-[#14532d]/60 bg-[#0d1f16] text-[#86efac]"
                      }`}
                    >
                      {statusLabel}
                    </span>
                  )}
                  <span className="font-mono text-[14px] font-bold">
                    <span className="text-[#34d399]">+{file.added}</span>
                    <span className="mx-1 text-[#52525b]"> </span>
                    <span className="text-[#ff5c5c]">-{file.removed}</span>
                  </span>
                  {showRevertButton && (
                    <button
                      type="button"
                      data-testid="diff-revert-file"
                      data-diff-path={file.path}
                      disabled={isReverting || file.revertStatus === "reverted"}
                      onClick={() => void handleRevertFiles([file])}
                      className="flex items-center gap-1.5 rounded-md border border-[#7f1d1d]/40 bg-[#1a0b0d] px-2.5 py-1 text-[11px] font-semibold text-[#fca5a5] transition-colors hover:border-[#ef4444]/45 hover:bg-[#2a1013] disabled:cursor-not-allowed disabled:opacity-50"
                      title={file.hasPendingReview
                        ? language === "zh" ? "拒绝这次待审批修改" : "Reject this pending change"
                        : language === "zh" ? "撤销这个文件的修改" : "Revert this file change"}
                    >
                      <IconRefresh className="h-3.5 w-3.5" />
                      {isReverting
                        ? language === "zh" ? "处理中" : "Working"
                        : file.hasPendingReview
                        ? language === "zh" ? "拒绝" : "Reject"
                        : language === "zh" ? "撤销" : "Revert"}
                    </button>
                  )}
                </div>
              </div>
              {file.revertStatus === "failed" && file.revertMessage && (
                <div className="border-t border-[#2a1416] bg-[#18090b] px-4 py-2 text-[12px] text-[#fca5a5]">
                  {file.revertMessage}
                </div>
              )}

              {!collapsed && (
                file.isBinaryLike ? (
                  <div className="flex h-20 items-center justify-center border-t border-[#252525] bg-[#242424] text-[13px] font-semibold text-[#a1a1aa]">
                    {language === "zh" ? "无内容" : "No content"}
                  </div>
                ) : (
                  <div className="overflow-x-auto bg-[#121212] font-mono text-[13px] leading-[22px]" style={{ fontFamily: CODE_FONT_FAMILY }}>
                    {rows.map((row) => (
                      row.kind === "fold" ? (
                        <div key={row.id} className="flex min-w-max border-y border-[#20242a] bg-[#1b1f26] text-[#a1a1aa]">
                          <div className="flex w-[72px] shrink-0 items-center justify-center border-r border-[#252a31] text-[#a1a1aa]">
                            <IconChevronDown className="h-3.5 w-3.5" />
                          </div>
                          <div className="px-4 py-1.5 text-[13px] font-semibold">
                            {language === "zh" ? `${row.count} 行未修改` : `${row.count} unmodified lines`}
                          </div>
                        </div>
                      ) : (
                        <div
                          key={row.id}
                          className={`flex min-w-max ${
                            row.type === "added"
                              ? "bg-[#173522] text-[#86d9a3]"
                              : row.type === "removed"
                              ? "bg-[#3a1d1f] text-[#ff6464]"
                              : "text-[#a6a6ad]"
                          }`}
                        >
                          <div className={`w-[48px] shrink-0 select-none border-r border-[#252525] pr-2 text-right ${row.type === "added" ? "text-[#34d399]" : row.type === "removed" ? "text-[#ff4d4d]" : "text-[#8f8f98]"}`}>
                            {row.type === "added" ? row.newLine : row.oldLine}
                          </div>
                          <div className={`w-[24px] shrink-0 select-none text-center ${row.type === "added" ? "text-[#34d399]" : row.type === "removed" ? "text-[#ff4d4d]" : "text-[#52525b]"}`}>
                            {row.type === "added" ? "+" : row.type === "removed" ? "-" : ""}
                          </div>
                          <pre className="m-0 flex-1 whitespace-pre px-2 text-inherit">{row.text || " "}</pre>
                        </div>
                      )
                    ))}
                  </div>
                )
              )}
            </section>
          );
        })}
      </div>
    </div>
  );
}

interface RightPanelProps {
  activeDiffTask?: any;
  rightPanelWidth: number;
  startResizing: (e: React.MouseEvent) => void;
}

export default function RightPanel({ activeDiffTask, rightPanelWidth, startResizing }: RightPanelProps) {
  const {
    showDiff,
    showPlanPanel,
    showTerminal,
    rightPanelTab,
    closeRightPanel,
    planArtifacts,
    planTasks,
    planExecutionEvidenceLedger,
    planStage,
    conversationTurns,
    taskFlow,
    approvePlan,
    rejectPlan,
    sendMessage,
    deletePersistedPlanFiles,
    agentStatus,
    config,
    isPlanApproved,
    currentWorkspace,
    currentSessionId,
    selectedDiffTaskId,
  } = {
    showDiff: useAppStore((s) => s.showDiff),
    showPlanPanel: useAppStore((s) => s.showPlanPanel),
    showTerminal: useAppStore((s) => s.showTerminal),
    rightPanelTab: useAppStore((s) => s.rightPanelTab),
    closeRightPanel: useAppStore((s) => s.closeRightPanel),
    planArtifacts: useAppStore((s) => s.planArtifacts),
    planTasks: useAppStore((s) => s.planTasks),
    planExecutionEvidenceLedger: useAppStore((s) => s.planExecutionEvidenceLedger),
    planStage: useAppStore((s) => s.planStage),
    conversationTurns: useAppStore((s) => s.conversationTurns),
    taskFlow: useAppStore((s) => s.taskFlow),
    approvePlan: useAppStore((s) => s.approvePlan),
    rejectPlan: useAppStore((s) => s.rejectPlan),
    sendMessage: useAppStore((s) => s.sendMessage),
    deletePersistedPlanFiles: useAppStore((s) => s.deletePersistedPlanFiles),
    agentStatus: useAppStore((s) => s.agentStatus),
    config: useAppStore((s) => s.config),
    isPlanApproved: useAppStore((s) => s.isPlanApproved),
    currentWorkspace: useAppStore((s) => s.currentWorkspace),
    currentSessionId: useAppStore((s) => s.currentSessionId),
    selectedDiffTaskId: useAppStore((s) => s.selectedDiffTaskId),
  };

  const selectedDiffTask = useMemo(() => {
    if (selectedDiffTaskId == null) return null;
    const task = taskFlow.find((block) => block.type === "tool" && block.id === selectedDiffTaskId && !!block.diff);
    return task?.type === "tool" ? task : null;
  }, [selectedDiffTaskId, taskFlow]);
  const viewedDiffTask = activeDiffTask ?? selectedDiffTask;
  const language = config.language === "en" ? "en" : "zh";
  const latestPlanEntry = useMemo(() => {
    const entries = conversationTurns.map((turn) => ({
      turn,
      blocks: taskFlow.filter((block) => block.turnId === turn.id),
    }));

    return [...entries].reverse().find((entry) => turnHasGeneratedPlan(entry.blocks)) || null;
  }, [conversationTurns, taskFlow]);
  const latestPlanTurn = useMemo(
    () => latestPlanEntry?.turn || [...conversationTurns].reverse().find((turn) => isPlanConversationTurn(turn)) || null,
    [conversationTurns, latestPlanEntry],
  );
  const changeSummary = useMemo(() => {
    const scopedTaskFlow = latestPlanTurn
      ? taskFlow.filter((block) => block.turnId === latestPlanTurn.id)
      : taskFlow;
    return collectChangeEntries(scopedTaskFlow, getDiffStats);
  }, [latestPlanTurn, taskFlow]);
  const fallbackPlanPreview = useMemo(() => {
    if (!latestPlanEntry) return "";

    for (const block of latestPlanEntry.blocks) {
      if (block.type !== "agent") continue;
      const proposal = extractStructuredPlanProposal(String(block.content || ""));
      if (proposal) return proposal.markdown;
      const draft = extractPlanDraftPreview(String(block.content || ""));
      if (draft) return draft;
    }

    return "";
  }, [latestPlanEntry]);
  const hasReviewablePlanDraft =
    fallbackPlanPreview.length > 0 &&
    planArtifacts.some((artifact) =>
      artifact.kind === "requirements" || artifact.kind === "design" || artifact.kind === "bugfix",
    );
  const hasActivePlanContext =
    !!latestPlanTurn ||
    planArtifacts.length > 0 ||
    fallbackPlanPreview.length > 0 ||
    planStage !== "idle";
  const canApproveExecution =
    hasActivePlanContext &&
    !isPlanApproved &&
    (
      planStage === "ready_to_execute" ||
      (latestPlanTurn?.status === "awaiting_approval" && hasReviewablePlanDraft) ||
      (agentStatus === "pending_review" && (hasReviewablePlanDraft || fallbackPlanPreview.length > 0))
    );
  const isAwaitingApproval =
    (hasActivePlanContext && agentStatus === "pending_review" && !isPlanApproved) || canApproveExecution;
  const isAwaitingInput =
    hasActivePlanContext &&
    !isPlanApproved &&
    latestPlanTurn?.status === "awaiting_input";
  const canContinuePlanning =
    hasActivePlanContext &&
    !isPlanApproved &&
    !isAwaitingInput &&
    !canApproveExecution &&
    (planArtifacts.length > 0 || fallbackPlanPreview.length > 0) &&
    agentStatus !== "running" &&
    agentStatus !== "pending_review";
  const canResumeExecution =
    hasActivePlanContext &&
    isPlanApproved &&
    planStage === "executing" &&
    (agentStatus === "idle" || agentStatus === "error") &&
    (
      planTasks.some((task) => !isPlanTaskTrustedComplete(task)) ||
      !planArtifacts.some((artifact) => artifact.kind === "tasks")
    );
  const handleContinuePlanning = () => {
    const isRequirementsStage = planStage === "requirements";
    sendMessage(
      language === "zh"
        ? isRequirementsStage
          ? "已生成 requirements.md。请不要重复读取已读文件，直接基于 requirements 和已有上下文生成 `.MAIN/plans/design.md`；如果设计方向不明确，用 `<user_options>` 给出用户可点击选择并停止。不要生成 tasks.md 或修改源码。"
          : "请基于当前已经生成的计划草案继续收敛，不要重复前文。优先补齐关键分叉点，并在需要用户确认时用面向用户的口吻给出可点击选项；如果已经足够清晰，就输出正式 Proposal 供用户确认。未经明确批准，不要提前生成执行用的 tasks.md。"
        : isRequirementsStage
        ? "requirements.md has been generated. Do not reread files already in context; generate `.MAIN/plans/design.md` directly from requirements and existing context. If the design direction is unclear, offer `<user_options>` and stop. Do not generate tasks.md or edit source files."
        : "Continue refining the current plan draft without repeating earlier content. Use clickable options when a real decision is needed; once the plan is clear enough, produce the formal proposal for approval. Do not generate execution tasks.md before the user explicitly approves execution.",
      undefined,
      { hidden: true, reuseCurrentTurn: true, preservePlanState: true, resolvedIntent: "plan", skipIntentResolution: true },
    );
  };
  const handleResumeExecution = () => {
    const e2eResumeHandler = getE2EResumeExecutionHandler();
    if (e2eResumeHandler) {
      void e2eResumeHandler();
      return;
    }

    const hasTasksArtifact =
      planArtifacts.some((artifact) => artifact.kind === "tasks") ||
      planTasks.length > 0;

    sendMessage(
      buildTrustedResumePrompt({
        language,
        hasTasksArtifact,
        tasks: planTasks,
        artifacts: planArtifacts,
        evidenceLedger: planExecutionEvidenceLedger,
      }),
      undefined,
      { hidden: true, reuseCurrentTurn: false, preservePlanState: true, resolvedIntent: "plan", skipIntentResolution: true },
    );
  };
  const handleSavePlanDocument = async (document: { title: string; suggestedFileName: string; content: string; sourcePath?: string }) => {
    const e2eSaveHandler = getE2ESavePlanDocumentHandler();
    if (e2eSaveHandler) {
      return e2eSaveHandler(document);
    }

    const suggestedName = sanitizeSuggestedFileName(document.suggestedFileName || document.title || "plan");
    const filePath = await save({
      defaultPath: suggestedName.endsWith(".md") ? suggestedName : `${suggestedName}.md`,
      filters: [
        { name: "Markdown", extensions: ["md"] },
      ],
    });
    if (!filePath) return false;
    await exportTextFile(filePath, document.content);
    const globalChatSessionKey =
      !currentWorkspace.trim()
        ? resolveGlobalChatSessionKey(currentSessionId)
        : null;
    if (globalChatSessionKey && document.sourcePath) {
      await deleteChatTempPath(globalChatSessionKey, document.sourcePath).catch(() => {});
    }
    return true;
  };
  const hasPlanPanelContent = planArtifacts.length > 0 || fallbackPlanPreview.length > 0;
  const panelMeta = useMemo(() => {
    if (rightPanelTab === "diff") {
      return {
        icon: IconColumns,
        title: language === "zh" ? "变更对比" : "Diff Viewer",
        description: viewedDiffTask?.target || (
          changeSummary.entries.length > 0
            ? language === "zh"
              ? `${changeSummary.entries.length} 个文件改动`
              : `${changeSummary.entries.length} changed file${changeSummary.entries.length > 1 ? "s" : ""}`
            : language === "zh" ? "查看当前待审批或最近一次文件变更。" : "Inspect the current pending or latest file diff."
        ),
      };
    }
    if (rightPanelTab === "terminal") {
      return {
        icon: IconTerminal,
        title: language === "zh" ? "集成终端" : "Terminal",
        description: language === "zh" ? "这里会同步显示当前线程中的终端输出。" : "Terminal output for the current thread appears here.",
      };
    }
    return {
      icon: IconFileText,
      title: language === "zh" ? "计划工作区" : "Plan Workspace",
      description: latestPlanTurn?.title || (language === "zh" ? "在这里查看计划预览、审批状态和执行进度。" : "Review plan previews, approval state, and execution progress here."),
    };
  }, [changeSummary.entries.length, language, latestPlanTurn?.title, rightPanelTab, viewedDiffTask?.target]);

  const isVisible = (showPlanPanel && hasPlanPanelContent) || showDiff || showTerminal;
  const terminalSessionKey = resolveSessionRuntimeKey(resolveSessionWorkspaceKey(currentWorkspace), currentSessionId) || undefined;

  if (!isVisible) return null;

  const HeaderIcon = panelMeta.icon;

  return (
    <>
      <div className="w-1 cursor-col-resize hover:bg-[#3f3f46] active:bg-[#555] z-20 transition-colors" onMouseDown={startResizing} />
      <div className="bg-[#000000] flex min-w-0 flex-col shrink-0 border-l border-[#27272a] z-10" style={{ width: `${rightPanelWidth}px`, display: window.innerWidth < 1220 ? "none" : "flex" }}>
        <div className="min-h-[56px] shrink-0 border-b border-[#27272a] bg-[#09090b] px-3 py-2 flex items-center justify-between gap-3">
          <div className="min-w-0 flex items-center gap-3">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg border border-[#27272a] bg-[#050505] text-[#e4e4e7]">
              <HeaderIcon className="h-4 w-4" />
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <div className="truncate text-[12px] font-semibold text-[#e4e4e7]">{panelMeta.title}</div>
                {rightPanelTab === "plan" && (
                  <span className={`shrink-0 whitespace-nowrap rounded-full border px-2 py-0.5 text-[10px] ${(isAwaitingApproval || isAwaitingInput) ? "border-[rgba(251,191,36,0.25)] bg-[rgba(251,191,36,0.12)] text-[#fbbf24]" : "border-[#27272a] bg-[#050505] text-[#a1a1aa]"}`}>
                    {isAwaitingApproval
                      ? language === "zh" ? "待审批" : "Awaiting Approval"
                      : isAwaitingInput
                      ? language === "zh" ? "待选择" : "Awaiting Choice"
                      : planArtifacts.length > 0
                      ? language === "zh" ? "已同步" : "Synced"
                      : fallbackPlanPreview
                      ? language === "zh" ? "预览" : "Preview"
                      : language === "zh" ? "空闲" : "Idle"}
                  </span>
                )}
              </div>
              <div className="truncate text-[11px] text-[#71717a]">{panelMeta.description}</div>
            </div>
          </div>

          <button onClick={closeRightPanel} className="text-[#a1a1aa] hover:text-white transition-colors p-1">
            <IconClose className="w-4 h-4" />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-hidden">
          {rightPanelTab === "plan" && hasPlanPanelContent && (
            <PlanPanel
              artifacts={planArtifacts}
              tasks={planTasks}
              stage={planStage}
              isAwaitingApproval={isAwaitingApproval}
              isAwaitingInput={isAwaitingInput}
              canApproveExecution={canApproveExecution}
              canContinuePlanning={canContinuePlanning}
              canResumeExecution={canResumeExecution}
              hideIslandOwnedSections
              isTemporaryWorkspace={!currentWorkspace.trim()}
              isApproved={isPlanApproved}
              language={language}
              turns={conversationTurns}
              fallbackPreview={fallbackPlanPreview}
              fallbackTitle={latestPlanTurn?.title}
              fallbackUpdatedAt={latestPlanTurn?.createdAt}
              onDeletePlanFiles={deletePersistedPlanFiles}
              onContinuePlanning={handleContinuePlanning}
              onResumeExecution={handleResumeExecution}
              onSaveDocument={handleSavePlanDocument}
              onApprove={approvePlan}
              onReject={rejectPlan}
            />
          )}

          {rightPanelTab === "diff" && (
            <DiffReviewPanel taskFlow={taskFlow} activeDiffTask={viewedDiffTask} language={language} />
          )}

          {rightPanelTab === "terminal" && (
            <div className="flex h-full flex-col bg-[#050505]">
              <div className="border-b border-[#18181b] px-4 py-3 text-[12px] text-[#a1a1aa]">{language === "zh" ? "终端输出" : "Terminal Output"}</div>
              <div className="flex-1 overflow-hidden bg-[#000000] p-1">
                <IntegratedTerminal
                  themeMode={config.themeMode}
                  workspace={currentWorkspace}
                  sessionKey={terminalSessionKey}
                />
              </div>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
