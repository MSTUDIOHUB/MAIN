// @ts-nocheck
import React, { useEffect, useMemo, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import {
  knowledgeBootstrapPreset,
  knowledgeCreateBase,
  knowledgeDeleteBase,
  knowledgeImportSource,
  knowledgeImportUrl,
  knowledgeCancelImportUrl,
  knowledgeListBases,
  knowledgeListPresets,
  knowledgeListSources,
  knowledgeRebuildBase,
  knowledgeSearch,
  knowledgeSetBaseEnabled,
  type EngineManualPreset,
  type KnowledgeBase,
  type KnowledgeSearchHit,
  type KnowledgeSource,
} from "../lib/ipc";
import { normalizeWebSearchProvider } from "../lib/networkRead";
import { useAppStore } from "../store/useAppStore";
import ToggleSwitch from "./ToggleSwitch";
import KnowledgeEvidence from "./KnowledgeEvidence";
import {
  IconBook,
  IconClose,
  IconFile,
  IconPlus,
  IconRefresh,
  IconSearch,
  IconTrash,
} from "./Icons";

const COPY = {
  zh: {
    title: "知识库",
    subtitle: "在聊天中输入 # 选择整库或单篇资料，仅本条消息检索。资料保存在个人知识库，不会把全文塞进上下文。",
    create: "新建知识库",
    namePlaceholder: "例如 Python 官方标准库",
    descPlaceholder: "用途说明，可选",
    import: "导入资料",
    rebuild: "重建索引",
    delete: "删除",
    enabled: "已启用",
    disabled: "未启用",
    enableBase: "启用知识库",
    sources: "来源",
    noBases: "暂无知识库",
    noSources: "暂无来源文件",
    status: "状态",
    chunks: "分块",
    deduped: "已存在，跳过重复导入",
    testSearch: "测试检索",
    searchPlaceholder: "输入问题或关键词",
    searching: "检索中...",
    close: "完成",
    importFailed: "导入失败",
    loading: "加载中...",
    desktopOnly: "知识库后端需要在 MAIN 桌面应用中使用；浏览器预览仅显示界面。",
  },
  en: {
    title: "Knowledge",
    subtitle: "Type # in chat to select libraries or documents for that message only. Your personal sources are searched locally; full documents are not injected.",
    create: "New Knowledge Base",
    namePlaceholder: "e.g. Python Standard Library Docs",
    descPlaceholder: "Optional description",
    import: "Import Sources",
    rebuild: "Rebuild Index",
    delete: "Delete",
    enabled: "Enabled",
    disabled: "Disabled",
    enableBase: "Enable knowledge base",
    sources: "Sources",
    noBases: "No knowledge bases yet",
    noSources: "No sources yet",
    status: "Status",
    chunks: "chunks",
    deduped: "Already exists, skipped duplicate import",
    testSearch: "Test Search",
    searchPlaceholder: "Ask a question or enter keywords",
    searching: "Searching...",
    close: "Done",
    importFailed: "Import failed",
    loading: "Loading...",
    desktopOnly: "The knowledge backend is available in the MAIN desktop app; browser preview only renders the UI.",
  },
} as const;

function formatSize(bytes: number) {
  const value = Number(bytes) || 0;
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

function normalizeSelectedFiles(selected: unknown): string[] {
  if (!selected) return [];
  if (Array.isArray(selected)) return selected.filter((item): item is string => typeof item === "string");
  return typeof selected === "string" ? [selected] : [];
}

function friendlyErrorMessage(err: unknown, copy: typeof COPY.zh | typeof COPY.en): string {
  const message = err instanceof Error ? err.message : String(err || "");
  if (/__TAURI__|invoke|is not a function|reading 'invoke'|reading "invoke"/i.test(message)) {
    return copy.desktopOnly;
  }
  return message;
}

export default function KnowledgeModal({ isOpen, onClose, currentWorkspace }: {
  isOpen: boolean;
  onClose: () => void;
  currentWorkspace?: string;
}) {
  const language = useAppStore((s) => s.config.language) === "en" ? "en" : "zh";
  const themeMode = useAppStore((s) => s.config.themeMode) || "dark";
  const isLight = themeMode === "light";
  const isBlack = themeMode === "black";
  const copy = COPY[language];
  const knowledgeBases = useAppStore((s) => s.knowledgeBases);
  const searchProvider = useAppStore((s) => s.webSearchProvider);
  const setKnowledgeBases = useAppStore((s) => s.setKnowledgeBases);
  const upsertKnowledgeBase = useAppStore((s) => s.upsertKnowledgeBase);
  const removeKnowledgeBase = useAppStore((s) => s.removeKnowledgeBase);
  const [selectedId, setSelectedId] = useState("");
  const [sources, setSources] = useState<KnowledgeSource[]>([]);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [allowWebFallbackSearch, setAllowWebFallbackSearch] = useState(false);
  const [hits, setHits] = useState<KnowledgeSearchHit[]>([]);
  const [presets, setPresets] = useState<readonly EngineManualPreset[]>([]);

  const [showImportMenu, setShowImportMenu] = useState(false);
  const [webImportState, setWebImportState] = useState<"idle" | "input" | "progress">("idle");
  const [webUrl, setWebUrl] = useState("");
  const [recursive, setRecursive] = useState(false);
  const [maxDepth, setMaxDepth] = useState(2);
  const [maxPages, setMaxPages] = useState(50);
  const [progress, setProgress] = useState({
    status: "",
    url: "",
    current: 0,
    total: 0,
    error: "",
  });

  const selectedBase = useMemo(
    () => knowledgeBases.find((base) => base.id === selectedId) || knowledgeBases[0] || null,
    [knowledgeBases, selectedId],
  );

  const ownerKey = `${isOpen}:${selectedBase?.id || ""}:${selectedBase?.indexRevision || ""}`;
  const ownerRef = useRef({ key: ownerKey, generation: 0 });
  if (ownerRef.current.key !== ownerKey) ownerRef.current = { key: ownerKey, generation: ownerRef.current.generation + 1 };
  const searchRequest = useRef<AbortController | null>(null);
  useEffect(() => {
    setHits([]);
    setBusy(current => current === "search" ? "" : current);
    return () => searchRequest.current?.abort();
  }, [ownerKey]);

  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    setBusy("load");
    knowledgeListPresets()
      .then((items) => {
        if (!cancelled && Array.isArray(items) && items.length > 0) {
          setPresets(items);
        }
      })
      .catch(() => {
        if (!cancelled) setPresets([]);
      });
    knowledgeListBases()
      .then((bases) => {
        if (cancelled) return;
        setKnowledgeBases(bases);
        setSelectedId((current) => current || bases[0]?.id || "");
      })
      .catch((err) => {
        if (!cancelled) setError(friendlyErrorMessage(err, copy));
      })
      .finally(() => {
        if (!cancelled) setBusy("");
      });
    return () => {
      cancelled = true;
    };
  }, [isOpen, setKnowledgeBases]);

  useEffect(() => {
    if (!isOpen || !selectedBase?.id) {
      setSources([]);
      return;
    }
    let cancelled = false;
    setSources([]);
    knowledgeListSources(selectedBase.id)
      .then((items) => {
        if (!cancelled) setSources(items);
      })
      .catch((err) => {
        if (!cancelled) setError(friendlyErrorMessage(err, copy));
      });
    return () => {
      cancelled = true;
    };
  }, [isOpen, selectedBase?.id]);

  useEffect(() => {
    const isPresetBusy = busy.startsWith("preset:");
    if ((webImportState !== "progress" || !selectedBase) && !isPresetBusy) return;
    let unlistenFn: (() => void) | null = null;
    
    const setupListener = async () => {
      const { listen } = await import("@tauri-apps/api/event");
      const unlisten = await listen<{
        kbId: string;
        presetId?: string;
        status: string;
        url?: string;
        current: number;
        total: number;
        error?: string;
      }>("knowledge-import-progress", (event) => {
        if (!isPresetBusy && selectedBase && event.payload.kbId !== selectedBase.id) return;
        setProgress({
          status: event.payload.status,
          url: event.payload.url || "",
          current: event.payload.current,
          total: event.payload.total,
          error: event.payload.error || "",
        });
        if (event.payload.status === "done" && webImportState === "progress" && selectedBase) {
          setWebImportState("idle");
          knowledgeListSources(selectedBase.id).then(setSources);
        }
      });
      unlistenFn = unlisten;
    };
    
    void setupListener();
    
    return () => {
      if (unlistenFn) unlistenFn();
    };
  }, [webImportState, selectedBase?.id, busy]);

  if (!isOpen) return null;

  const createBase = async () => {
    const trimmed = name.trim();
    if (!trimmed || busy) return;
    setBusy("create");
    setError("");
    try {
      const base = await knowledgeCreateBase(trimmed, description.trim());
      upsertKnowledgeBase(base);
      setSelectedId(base.id);
      setName("");
      setDescription("");
    } catch (err) {
      setError(friendlyErrorMessage(err, copy));
    } finally {
      setBusy("");
    }
  };

  const bootstrapPreset = async (presetId: string) => {
    if (busy) return;
    setBusy(`preset:${presetId}`);
    setError("");
    try {
      const base = await knowledgeBootstrapPreset(presetId);
      upsertKnowledgeBase(base);
      setSelectedId(base.id);
      setSources(await knowledgeListSources(base.id));
    } catch (err) {
      setError(friendlyErrorMessage(err, copy));
    } finally {
      setBusy("");
    }
  };

  const toggleBaseEnabled = async (base: KnowledgeBase, enabled: boolean) => {
    if (busy) return;
    setBusy(`toggle:${base.id}`);
    setError("");
    try {
      const updated = await knowledgeSetBaseEnabled(base.id, enabled);
      upsertKnowledgeBase(updated);
    } catch (err) {
      setError(friendlyErrorMessage(err, copy));
    } finally {
      setBusy("");
    }
  };

  const startWebImport = async () => {
    if (!selectedBase || !webUrl.trim() || busy) return;
    setBusy("web-import");
    setError("");
    setProgress({
      status: "starting",
      url: webUrl.trim(),
      current: 0,
      total: 1,
      error: "",
    });
    setWebImportState("progress");
    try {
      const result = await knowledgeImportUrl(
        selectedBase.id,
        webUrl.trim(),
        recursive,
        maxDepth,
        maxPages,
      );
      upsertKnowledgeBase(result);
      setSources(await knowledgeListSources(selectedBase.id));
      setWebImportState("idle");
      setWebUrl("");
    } catch (err) {
      setError(friendlyErrorMessage(err, copy));
      setWebImportState("idle");
    } finally {
      setBusy("");
    }
  };

  const cancelWebImport = async () => {
    if (!selectedBase) return;
    try {
      await knowledgeCancelImportUrl(selectedBase.id);
    } catch (err) {
      console.error("Cancel web import failed:", err);
    }
  };

  const importSources = async () => {
    if (!selectedBase || busy) return;
    setBusy("import");
    setError("");
    try {
      const selected = await open({
        multiple: true,
        filters: [{
          name: "Documents",
          extensions: ["pdf", "docx", "xlsx", "xls", "csv", "tsv", "txt", "md", "markdown", "rst", "html", "htm"],
        }],
      });
      const files = normalizeSelectedFiles(selected);
      for (const file of files) {
        const result = await knowledgeImportSource(selectedBase.id, file, currentWorkspace || undefined);
        upsertKnowledgeBase(result.base);
      }
      setSources(await knowledgeListSources(selectedBase.id));
    } catch (err) {
      setError(`${copy.importFailed}: ${friendlyErrorMessage(err, copy)}`);
    } finally {
      setBusy("");
    }
  };

  const rebuildBase = async () => {
    if (!selectedBase || busy) return;
    setBusy("rebuild");
    setError("");
    try {
      upsertKnowledgeBase(await knowledgeRebuildBase(selectedBase.id));
      setSources(await knowledgeListSources(selectedBase.id));
    } catch (err) {
      setError(friendlyErrorMessage(err, copy));
    } finally {
      setBusy("");
    }
  };

  const deleteBase = async () => {
    if (!selectedBase || busy) return;
    setBusy("delete");
    setError("");
    try {
      await knowledgeDeleteBase(selectedBase.id);
      removeKnowledgeBase(selectedBase.id);
      const remaining = knowledgeBases.filter((base) => base.id !== selectedBase.id);
      setSelectedId(remaining[0]?.id || "");
      setSources([]);
      setHits([]);
    } catch (err) {
      setError(friendlyErrorMessage(err, copy));
    } finally {
      setBusy("");
    }
  };

  const runSearch = async () => {
    if (!selectedBase || !searchQuery.trim() || busy) return;
    const requestOwner = ownerRef.current.generation;
    const request = new AbortController();
    searchRequest.current = request;
    setBusy("search");
    setError("");
    try {
      const bases = await knowledgeListBases();
      request.signal.throwIfAborted();
      const base = bases.find(item => item.id === selectedBase.id);
      if (!base) throw new Error(copy.noBases);
      const allowNetwork = allowWebFallbackSearch && base.enabled && !!base.presetId;
      const result = await knowledgeSearch(
        searchQuery.trim(),
        [{
          kind: "base",
          kbId: base.id,
          indexRevision: base.indexRevision,
          ...(allowNetwork ? { activationMode: "workspace_active", presetId: base.presetId! } as const : {}),
        }],
        6,
        allowNetwork ? { mode: "officialSearch", provider: normalizeWebSearchProvider(searchProvider) } : { mode: "local" },
        request.signal,
      );
      if (ownerRef.current.generation === requestOwner) setHits(result.hits || []);
    } catch (err) {
      if (!request.signal.aborted && ownerRef.current.generation === requestOwner) setError(friendlyErrorMessage(err, copy));
    } finally {
      if (searchRequest.current === request) searchRequest.current = null;
      if (ownerRef.current.generation === requestOwner) setBusy("");
    }
  };

  const errorBoxClass = isLight
    ? "border-[#fca5a5] bg-[#fef2f2] text-[#b91c1c]"
    : isBlack
      ? "border-[#7f1d1d] bg-[#220c0e] text-[#fca5a5]"
      : "border-[#7f1d1d] bg-[#3a1d1f] text-[#fca5a5]";

  const dangerButtonClass = isLight
    ? "border-[#fca5a5] bg-[#fef2f2] text-[#dc2626] hover:bg-[#fee2e2]"
    : isBlack
      ? "border-[#7f1d1d] bg-[#140a0c] text-[#fca5a5] hover:bg-[#2a1215]"
      : "border-[#7f1d1d] bg-[#1f1214] text-[#fca5a5] hover:bg-[#3a1d1f]";

  const enabledBadgeClass = isLight
    ? "border border-[#86efac] bg-[#dcfce7] text-[#047857]"
    : isBlack
      ? "border border-[#166534] bg-[#031d0e] text-[#34d399]"
      : "border border-[#166534] bg-[#052e16] text-[#34d399]";

  const disabledBadgeClass = isLight
    ? "border border-[#d4d4d8] bg-[#e4e4e7] text-[#52525b]"
    : "bg-[#18181b] text-[#71717a]";

  const selectedCardClass = isLight
    ? "theme-border bg-[color-mix(in_srgb,var(--accent,#9333ea)_7%,#ffffff_93%)] shadow-xs"
    : isBlack
      ? "theme-border bg-[color-mix(in_srgb,var(--accent,#9333ea)_16%,#050507_84%)]"
      : "theme-border bg-[color-mix(in_srgb,var(--accent,#9333ea)_14%,#19191d_86%)]";

  const idlePresetCardClass = isLight
    ? "border-[#d4d4d8] bg-[#f8fafc] hover:border-[#a1a1aa]"
    : isBlack
      ? "border-[#202026] bg-[#050507] hover:border-[#303038]"
      : "border-[#2b2b32] bg-[#151518] hover:border-[#3f3f48]";

  return (
    <div
      data-theme-mode={themeMode}
      className={`absolute inset-0 z-50 flex items-center justify-center backdrop-blur-sm ${
        isLight ? "bg-slate-900/45" : "bg-black/80"
      }`}
    >
      <div className="flex max-h-[82vh] w-[860px] overflow-hidden rounded-xl border border-[#27272a] bg-[#09090b] shadow-2xl">
        <div className="flex w-[280px] shrink-0 flex-col border-r border-[#27272a] bg-[#050507]">
          <div className="flex items-center justify-between border-b border-[#27272a] px-4 py-4">
            <div className="flex items-center gap-2 text-sm font-bold text-white">
              <IconBook className="h-4 w-4" />
              {copy.title}
            </div>
            <button onClick={onClose} className="text-[#a1a1aa] hover:text-white">
              <IconClose className="h-4 w-4" />
            </button>
          </div>
          <div className="space-y-2 border-b border-[#27272a] p-3">
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder={copy.namePlaceholder}
              className="w-full rounded-md border border-[#27272a] bg-[#000000] px-3 py-2 text-xs text-white outline-none theme-ring"
            />
            <input
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              placeholder={copy.descPlaceholder}
              className="w-full rounded-md border border-[#27272a] bg-[#000000] px-3 py-2 text-xs text-white outline-none theme-ring"
            />
            <button
              onClick={createBase}
              disabled={!name.trim() || !!busy}
              className="flex w-full items-center justify-center gap-2 rounded-md theme-bg px-3 py-2 text-xs font-bold transition-colors theme-bg-hover disabled:opacity-50"
            >
              <IconPlus className="h-3.5 w-3.5" />
              {copy.create}
            </button>
          </div>
          <div className="flex-1 overflow-y-auto p-3">
            {knowledgeBases.length === 0 ? (
              <div className="py-8 text-center text-xs text-[#71717a]">{busy === "load" ? copy.loading : copy.noBases}</div>
            ) : (
              <div className="space-y-2">
                {knowledgeBases.map((base) => (
                  <button
                    key={base.id}
                    disabled={!!busy}
                    onClick={() => setSelectedId(base.id)}
                    className={`w-full rounded-lg border p-3 text-left transition-colors ${
                      selectedBase?.id === base.id
                        ? selectedCardClass
                        : "border-[#27272a] bg-[#000000] hover:border-[#3f3f46]"
                    }`}
                  >
                    <div className="flex items-center gap-2">
                      <span className="min-w-0 flex-1 truncate text-xs font-bold text-[#f4f4f5]">{base.name}</span>
                      <span className={`rounded px-1.5 py-0.5 text-[9px] font-bold ${base.enabled ? enabledBadgeClass : disabledBadgeClass}`}>
                        {base.enabled ? copy.enabled : copy.disabled}
                      </span>
                    </div>
                    <div className="mt-1 text-[10px] text-[#71717a]">
                      {base.sourceCount} {copy.sources}
                      {(base.tocEntryCount ?? 0) > 0 ? ` · ${base.tocEntryCount} TOC` : ""}
                      {" · "}
                      {base.indexStatus}
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        <div className="flex min-w-0 flex-1 flex-col">
          <div className="border-b border-[#27272a] px-5 py-4">
            <p className="text-xs text-[#a1a1aa]">{copy.subtitle}</p>
            {error && (
              <p
                role="alert"
                className={`mt-2.5 rounded-md border px-3 py-2 text-xs font-medium ${errorBoxClass}`}
              >
                {error}
              </p>
            )}
            <div className="mt-3">
              <div className="mb-2 flex items-center justify-between">
                <span className="text-[11px] font-bold uppercase tracking-wide text-[#e4e4e7]">
                  {language === "en" ? "Official Engine Code Manuals (One-Click Acquire & Auto-Sync)" : "官方引擎代码手册 (一键获取 · 零预注入按需检索 · 联网穿透)"}
                </span>
                <span className="text-[10px] text-[#71717a]">
                  {language === "en" ? "Workspace-aware mutual exclusion + Navigator Skill" : "自动识别工作区引擎 · 跨引擎互斥 · 自动挂载导航 Skill"}
                </span>
              </div>
              <div className="grid grid-cols-3 gap-2.5">
                {presets.map((preset) => {
                  const matchedBase = knowledgeBases.find(
                    (base) => base.presetId === preset.presetId,
                  );
                  const isBootstrapping = busy === `preset:${preset.presetId}`;
                  const isSelectedPreset = !!matchedBase && selectedBase?.id === matchedBase.id;
                  return (
                    <div
                      key={preset.presetId}
                      className={`flex flex-col justify-between rounded-lg border p-2.5 transition-colors ${
                        isSelectedPreset ? selectedCardClass : idlePresetCardClass
                      }`}
                    >
                      <div>
                        <div className="flex items-center justify-between gap-1.5">
                          <button
                            type="button"
                            onClick={() => matchedBase && setSelectedId(matchedBase.id)}
                            className={`truncate text-left text-xs font-bold hover:underline ${
                              isLight ? "text-[#09090b]" : "text-[#fafafa]"
                            }`}
                          >
                            {preset.name}
                          </button>
                          {matchedBase && (
                            <ToggleSwitch
                              checked={matchedBase.enabled}
                              disabled={!!busy}
                              onCheckedChange={(checked) => void toggleBaseEnabled(matchedBase, checked)}
                              aria-label={`${copy.enableBase}: ${preset.name}`}
                            />
                          )}
                        </div>
                        <p className={`mt-1 line-clamp-2 text-[10px] leading-relaxed ${isLight ? "text-[#52525b]" : "text-[#a1a1aa]"}`}>
                          {preset.description}
                        </p>
                        <p className={`mt-1 text-[10px] ${isLight ? "text-[#52525b]" : "text-[#a1a1aa]"}`}>
                          {preset.documentationVersion}
                          {matchedBase && ` · ${matchedBase.tocIndexedSourceCount ?? 0}/${preset.tocUrls.length} ${language === "en" ? "verified indexes" : "已核验目录"}`}
                        </p>
                        {matchedBase?.presetSyncStatus === "partial" && (
                          <p role="status" className="mt-1 text-[10px] opacity-80">
                            {language === "en" ? "Some official files could not be acquired" : "部分官方文件获取失败"}
                          </p>
                        )}
                      </div>
                      <div
                        className={`mt-2.5 flex items-center justify-between gap-2 border-t pt-2 ${
                          isLight ? "border-[#e4e4e7]" : isBlack ? "border-[#18181b]" : "border-[#232329]"
                        }`}
                      >
                        <span className={`truncate text-[10px] font-medium ${isLight ? "text-[#52525b]" : "text-[#8c8c97]"}`}>
                          {isBootstrapping && progress.total > 0
                            ? `${progress.current} / ${progress.total}`
                            : matchedBase
                              ? `${matchedBase.sourceCount} ${copy.sources} · ${matchedBase.tocEntryCount ?? 0} TOC`
                              : language === "en"
                                ? "Not acquired"
                                : "尚未获取"}
                        </span>
                        <button
                          type="button"
                          disabled={!!busy}
                          onClick={() => void bootstrapPreset(preset.presetId)}
                          title={language === "en" ? "Download from the official documentation site" : "从官方文档站点联网获取"}
                          className={`shrink-0 rounded px-2.5 py-1 text-[10px] font-bold transition-colors disabled:opacity-50 ${
                            matchedBase
                              ? isLight
                                ? "border border-[#d4d4d8] bg-[#ffffff] text-[#18181b] hover:bg-[#f4f4f5]"
                                : isBlack
                                  ? "border border-[#27272a] bg-[#121216] text-[#e4e4e7] hover:bg-[#1d1d23] hover:text-white"
                                  : "border border-[#3f3f46] bg-[#202025] text-[#e4e4e7] hover:bg-[#27272d] hover:text-white"
                              : "theme-bg theme-bg-hover"
                          }`}
                        >
                          {isBootstrapping
                            ? language === "en"
                              ? "Syncing..."
                              : "正在获取..."
                            : matchedBase
                              ? language === "en"
                                ? "Download update"
                                : "联网更新"
                              : language === "en"
                                ? "Download manual"
                                : "联网获取"}
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>

          {selectedBase ? (
            <div className="flex-1 overflow-y-auto p-5">
              <div className="mb-4 flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <h3 className="truncate text-base font-bold text-white">{selectedBase.name}</h3>
                  <p className="mt-1 text-xs text-[#a1a1aa]">{selectedBase.description || (language === "en" ? "Local keyword retrieval" : "本地关键词检索")}</p>
                </div>
                <div className="flex shrink-0 items-center gap-3">
                  <label className="flex items-center gap-2 text-xs text-[#a1a1aa] cursor-pointer hover:text-white">
                    <ToggleSwitch
                      checked={selectedBase.enabled}
                      disabled={!!busy}
                      onCheckedChange={(checked) => void toggleBaseEnabled(selectedBase, checked)}
                      aria-label={copy.enableBase}
                    />
                    <span>{selectedBase.enabled ? copy.enabled : copy.disabled}</span>
                  </label>
                  <div className="relative">
                    <button
                      onClick={() => setShowImportMenu(!showImportMenu)}
                      disabled={!!busy}
                      className="flex items-center gap-2 rounded-md theme-bg px-3 py-2 text-xs font-bold theme-bg-hover disabled:opacity-50"
                    >
                      <IconFile className="h-3.5 w-3.5" />
                      {copy.import}
                    </button>
                    {showImportMenu && (
                      <div className="absolute right-0 mt-1.5 z-50 w-40 rounded-md border border-[#27272a] bg-[#09090b] shadow-2xl py-1">
                        <button
                          onClick={() => {
                            setShowImportMenu(false);
                            void importSources();
                          }}
                          className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-[#e4e4e7] hover:bg-[#18181b] hover:text-white"
                        >
                          <IconFile className="h-3.5 w-3.5 text-[#a1a1aa]" />
                          导入本地文件
                        </button>
                        <button
                          onClick={() => {
                            setShowImportMenu(false);
                            setWebImportState("input");
                          }}
                          className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-[#e4e4e7] hover:bg-[#18181b] hover:text-white"
                        >
                          <IconBook className="h-3.5 w-3.5 text-[#a1a1aa]" />
                          网页文档导入
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              </div>

              {webImportState === "input" && (
                <div className="mb-5 rounded-lg border border-[#3f3f46] bg-[#0d0d11]/80 backdrop-blur-sm p-4 space-y-3 shadow-lg transition-all duration-300">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-bold text-white flex items-center gap-1.5">
                      <IconBook className="h-3.5 w-3.5 text-[#3b82f6]" />
                      导入网页/在线文档
                    </span>
                    <button
                      onClick={() => setWebImportState("idle")}
                      className="text-[#a1a1aa] hover:text-white text-xs font-bold"
                    >
                      取消
                    </button>
                  </div>
                  <div className="space-y-2">
                    <input
                      value={webUrl}
                      onChange={(e) => setWebUrl(e.target.value)}
                      placeholder="输入网页链接 (例如 https://docs.python.org/3/library/os.html)"
                      className="w-full rounded-md border border-[#27272a] bg-[#000000] px-3 py-2 text-xs text-white outline-none theme-ring"
                    />
                    <div className="flex flex-wrap items-center gap-4 text-xs text-[#a1a1aa] pt-1">
                      <label className="flex items-center gap-2 cursor-pointer hover:text-white transition-colors">
                        <ToggleSwitch
                          checked={recursive}
                          onCheckedChange={setRecursive}
                          aria-label="递归导入子链接"
                        />
                        递归导入子链接
                      </label>
                      {recursive && (
                        <>
                          <div className="flex items-center gap-1.5">
                            <span>最大深度</span>
                            <select
                              value={maxDepth}
                              onChange={(e) => setMaxDepth(Number(e.target.value))}
                              className="rounded border border-[#27272a] bg-[#000000] px-2 py-1 text-xs text-white outline-none"
                            >
                              <option value={1}>1 层 (仅直接子链接)</option>
                              <option value={2}>2 层 (推荐)</option>
                              <option value={3}>3 层 (较多页面)</option>
                            </select>
                          </div>
                          <div className="flex items-center gap-1.5">
                            <span>页面限制</span>
                            <select
                              value={maxPages}
                              onChange={(e) => setMaxPages(Number(e.target.value))}
                              className="rounded border border-[#27272a] bg-[#000000] px-2 py-1 text-xs text-white outline-none"
                            >
                              <option value={10}>10 页</option>
                              <option value={20}>20 页</option>
                              <option value={50}>50 页 (推荐)</option>
                              <option value={100}>100 页</option>
                            </select>
                          </div>
                        </>
                      )}
                    </div>
                  </div>
                  <button
                    onClick={startWebImport}
                    disabled={!webUrl.trim() || !!busy}
                    className="w-full rounded-md theme-bg py-2 text-xs font-bold transition-colors theme-bg-hover disabled:opacity-50"
                  >
                    开始抓取与本地索引
                  </button>
                </div>
              )}

              {webImportState === "progress" && (
                <div className="mb-5 rounded-lg border border-[#3b82f6] bg-[#0d0d11]/80 backdrop-blur-sm p-4 space-y-3 shadow-lg">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-bold text-white flex items-center gap-1.5 animate-pulse">
                      <span className="flex h-2 w-2 relative">
                        <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-[#3b82f6] opacity-75"></span>
                        <span className="relative inline-flex rounded-full h-2 w-2 bg-[#3b82f6]"></span>
                      </span>
                      正在爬取网页并建立本地索引...
                    </span>
                    <button
                      onClick={cancelWebImport}
                      className={`rounded border px-2.5 py-1 text-[10px] font-medium transition-colors ${dangerButtonClass}`}
                    >
                      终止抓取
                    </button>
                  </div>
                  
                  <div className="space-y-1.5">
                    <div className="flex justify-between text-[11px]">
                      <span className="text-[#a1a1aa] truncate max-w-[70%]">
                        {progress.status === "fetching" ? `抓取中: ${progress.url}` : "准备中..."}
                      </span>
                      <span className="text-[#3b82f6] font-bold">
                        {progress.current} / {progress.total} 页
                      </span>
                    </div>
                    <div className="h-1.5 w-full bg-[#000000] rounded-full overflow-hidden">
                      <div
                        className="h-full bg-[#3b82f6] transition-all duration-300"
                        style={{
                          width: `${Math.min(100, Math.max(5, (progress.current / (progress.total || 1)) * 100))}%`
                        }}
                      ></div>
                    </div>
                  </div>
                </div>
              )}

              <div className="mb-5 flex items-center gap-2">
                <button onClick={rebuildBase} disabled={!!busy || sources.length === 0} className="flex items-center gap-2 rounded-md border border-[#27272a] bg-[#000000] px-3 py-2 text-xs text-[#a1a1aa] hover:bg-[#18181b] hover:text-white disabled:opacity-50">
                  <IconRefresh className="h-3.5 w-3.5" />
                  {copy.rebuild}
                </button>
                <button onClick={deleteBase} disabled={!!busy} className={`flex items-center gap-2 rounded-md border px-3 py-2 text-xs font-medium transition-colors disabled:opacity-50 ${dangerButtonClass}`}>
                  <IconTrash className="h-3.5 w-3.5" />
                  {copy.delete}
                </button>
              </div>

              <div className="mb-5">
                <div className="mb-2 text-xs font-bold uppercase tracking-wide text-[#71717a]">{copy.sources}</div>
                {sources.length === 0 ? (
                  <div className="rounded-lg border border-[#27272a] bg-[#000000] p-5 text-center text-xs text-[#71717a]">{copy.noSources}</div>
                ) : (
                  <div className="space-y-2">
                    {sources.map((source) => (
                      <div key={source.id} className="rounded-lg border border-[#27272a] bg-[#000000] p-3">
                        <div className="flex items-center gap-2">
                          <IconFile className="h-4 w-4 text-[#a1a1aa]" />
                          <span className="min-w-0 flex-1 truncate text-xs font-bold text-[#e4e4e7]">{source.title}</span>
                          <span className="text-[10px] text-[#71717a]">{formatSize(source.size)}</span>
                        </div>
                        <div className="mt-1 flex flex-wrap gap-2 text-[10px] text-[#71717a]">
                          <span>{copy.status}: {source.provenance === "unverified_legacy"
                            ? (language === "en" ? "Reverification needed" : "等待重新核验")
                            : source.status}</span>
                          <span>{source.ext}</span>
                          <span>{source.hash}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <div>
                <div className="mb-2 flex items-center justify-between">
                  <div className="text-xs font-bold uppercase tracking-wide text-[#71717a]">{copy.testSearch}</div>
                  <label className="flex items-center gap-2 text-[11px] text-[#a1a1aa] cursor-pointer hover:text-white">
                    <ToggleSwitch
                      checked={allowWebFallbackSearch}
                      onCheckedChange={setAllowWebFallbackSearch}
                      disabled={!selectedBase?.enabled || !selectedBase?.presetId}
                      aria-label="允许官方站点联网穿透检索"
                    />
                    <span>{language === "en" ? "Allow official web fallback & auto-cache" : "未命中时允许官方站点联网检索并自动缓存"}</span>
                  </label>
                </div>
                <div className="flex gap-2">
                  <input
                    value={searchQuery}
                    onChange={(event) => setSearchQuery(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") void runSearch();
                    }}
                    placeholder={copy.searchPlaceholder}
                    className="min-w-0 flex-1 rounded-md border border-[#27272a] bg-[#000000] px-3 py-2 text-xs text-white outline-none theme-ring"
                  />
                  <button onClick={runSearch} disabled={!searchQuery.trim() || !!busy} className="flex items-center gap-2 rounded-md border border-[#27272a] bg-[#18181b] px-3 py-2 text-xs font-bold text-[#e4e4e7] hover:bg-[#27272a] disabled:opacity-50">
                    <IconSearch className="h-3.5 w-3.5" />
                    {busy === "search" ? copy.searching : copy.testSearch}
                  </button>
                </div>
                {hits.length > 0 && (
                  <div className="mt-3 space-y-2">
                    {hits.map((hit) => (
                      <div key={hit.citation.chunkId} className="rounded-lg border border-[#27272a] bg-[#000000] p-3">
                        <div className="mb-1 text-[10px] font-bold text-[#86d9a3]">
                          {hit.citation.sourceTitle}
                          {hit.citation.page ? ` · p.${hit.citation.page}` : ""}
                          {hit.citation.block ? ` · ${hit.citation.block}` : ""}

                        </div>
                        <KnowledgeEvidence packet={{ state: "retrieved", query: searchQuery, references: selectedBase ? [{ kind: "base", kbId: selectedBase.id, indexRevision: selectedBase.indexRevision }] : [], hits: [hit], note: "" }} language={language === "en" ? "en" : "zh"} />
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          ) : (
            <div className="flex flex-1 items-center justify-center text-xs text-[#71717a]">{copy.noBases}</div>
          )}

          <div className="flex justify-end border-t border-[#27272a] bg-[#000000] px-5 py-4">
            <button onClick={onClose} className="rounded-md theme-bg px-6 py-1.5 text-xs font-bold theme-bg-hover">
              {copy.close}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
