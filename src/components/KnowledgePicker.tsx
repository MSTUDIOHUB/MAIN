import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { knowledgeListBases, knowledgeListSources } from "../lib/ipc";
import { knowledgeReferenceIdentity, type KnowledgeReference } from "../lib/knowledgeReferences";
import { filterKnowledgePickerCandidates, type KnowledgePickerCandidate, type KnowledgePickerSession } from "../lib/knowledgePicker";

export interface KnowledgePickerHandle { handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): boolean }

/** Source choice is staged here, then committed atomically with the current token. */
const KnowledgePicker = forwardRef<KnowledgePickerHandle, {
  session: KnowledgePickerSession | null;
  ownerKey: string;
  selected: readonly KnowledgeReference[];
  language: "zh" | "en";
  onComplete: (refs: readonly KnowledgeReference[], session: KnowledgePickerSession) => void;
  onClose: () => void;
}>(function KnowledgePicker({ session, ownerKey, selected, language, onComplete, onClose }, ref) {
  const zh = language === "zh";
  const [items, setItems] = useState<KnowledgePickerCandidate[]>([]);
  const [draft, setDraft] = useState<readonly KnowledgeReference[]>(selected);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [highlight, setHighlight] = useState(0);
  const generation = useRef(0);
  const settledOwner = useRef<string | null>(null);
  const open = !!session;
  useEffect(() => {
    const current = ++generation.current;
    if (!open) return;
    settledOwner.current = null;
    setDraft(selected);
    setItems([]);
    setLoading(true);
    setError("");
    void (async () => {
      const bases = await knowledgeListBases();
      const sources = await Promise.allSettled(bases.map(base => knowledgeListSources(base.id)));
      if (current !== generation.current) return;
      const next: KnowledgePickerCandidate[] = [];
      for (const [index, base] of bases.entries()) {
        next.push({ id: `base:${base.id}`, kind: "base", label: base.name, description: `${zh ? "整库" : "Library"} · ${base.sourceCount} · ${base.indexStatus}`, ready: base.sourceCount > 0 && ["ready", "error"].includes(base.indexStatus) && !!base.indexRevision,
          reference: { kind: "base", kbId: base.id, indexRevision: base.indexRevision, label: base.name } });
        const result = sources[index]!;
        if (result.status === "rejected") { setError(zh ? "部分资料列表加载失败，请关闭后重试。" : "Some source lists could not be loaded. Close and retry."); continue; }
        for (const source of result.value) next.push({ id: `source:${base.id}:${source.id}`, kind: "source", label: source.title, description: `${base.name} · ${source.status}`, ready: source.status === "indexed" && !!source.sourceRevision,
          reference: { kind: "source", kbId: base.id, sourceId: source.id, sourceRevision: source.sourceRevision, label: source.title } });
      }
      settledOwner.current = ownerKey;
      setItems(next);
    })().catch(() => { if (current === generation.current) setError(zh ? "无法加载知识库，请在桌面应用中检查资料索引。" : "Could not load sources. Check their index in the desktop app."); })
      .finally(() => { if (current === generation.current) setLoading(false); });
    return () => { generation.current++; };
    // Selection is captured only when this owner opens the picker.
  }, [open, ownerKey, zh]);
  const visible = useMemo(() => filterKnowledgePickerCandidates(items, session?.query || ""), [items, session?.query]);
  useEffect(() => setHighlight(0), [session?.query]);
  const toggle = (candidate: KnowledgePickerCandidate) => {
    if (!candidate.ready || loading || settledOwner.current !== ownerKey) return;
    const id = knowledgeReferenceIdentity(candidate.reference);
    setDraft(previous => previous.some(item => knowledgeReferenceIdentity(item) === id)
      ? previous.filter(item => knowledgeReferenceIdentity(item) !== id)
      : [...previous, candidate.reference]);
  };
  const complete = () => {
    if (!session || loading || settledOwner.current !== ownerKey) return;
    const fallback = visible[highlight];
    const refs = draft.length ? draft : fallback?.ready ? [fallback.reference] : [];
    if (refs.length) onComplete(refs, session);
  };
  useImperativeHandle(ref, () => ({ handleKeyDown(event) {
    if (!session || event.nativeEvent.isComposing) return false;
    if (event.key === "Escape") { event.preventDefault(); onClose(); return true; }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      setHighlight(previous => Math.max(0, Math.min(visible.length - 1, previous + (event.key === "ArrowDown" ? 1 : -1))));
      return true;
    }
    if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); complete(); return true; }
    return false;
  }}));
  if (!session) return null;
  return <div role="dialog" aria-label={zh ? "选择知识资料" : "Select knowledge sources"} data-testid="knowledge-picker"
    className="absolute bottom-full left-4 right-4 z-50 mb-2 overflow-hidden rounded-xl border shadow-xl"
    style={{ background: "var(--surface-1)", borderColor: "var(--surface-border)", color: "var(--surface-text)" }}>
    <div className="border-b px-3 py-2 text-xs" style={{ borderColor: "var(--surface-border)" }}>
      <strong># {zh ? "本条消息的资料" : "Sources for this message"}</strong>
      <span className="ml-2 opacity-65">{session.query}</span>
    </div>
    <div className="max-h-64 overflow-y-auto p-1" role="group" aria-label={zh ? "知识库与资料" : "Libraries and sources"}>
      {loading && <p role="status" className="px-3 py-4 text-xs">{zh ? "加载中…" : "Loading…"}</p>}
      {!!error && <p role="status" className="px-3 py-2 text-xs">{error}</p>}
      {!loading && !visible.length && <p className="px-3 py-4 text-xs opacity-65">{zh ? "没有匹配资料，请先在知识库导入资料。" : "No sources found. Import documents in Knowledge first."}</p>}
      {visible.map((candidate, index) => <label key={candidate.id}
        data-knowledge-id={candidate.id} className="flex cursor-pointer items-center gap-2 rounded-md px-3 py-2 text-xs"
        style={{ background: highlight === index ? "var(--surface-hover)" : undefined, opacity: candidate.ready ? 1 : .5 }}>
        <input type="checkbox" checked={draft.some(item => knowledgeReferenceIdentity(item) === knowledgeReferenceIdentity(candidate.reference))}
          disabled={!candidate.ready} onChange={() => toggle(candidate)} aria-label={candidate.label} />
        <span className="min-w-0"><span className="block truncate">{candidate.kind === "base" ? "▣ " : "↳ "}{candidate.label}</span><span className="block truncate text-[10px] opacity-60">{candidate.description}</span></span>
      </label>)}
    </div>
    <div className="flex items-center justify-between border-t px-3 py-2 text-[10px]" style={{ borderColor: "var(--surface-border)" }}>
      <span className="opacity-60">{zh ? "可多选 · Enter 添加 · Esc 关闭" : "Multiple sources · Enter to add · Esc to close"}</span>
      <button type="button" onClick={complete} disabled={loading || !draft.length} className="rounded px-2 py-1 text-xs disabled:opacity-40" style={{ background: "var(--surface-hover)" }}>{zh ? `添加所选 (${draft.length})` : `Add selected (${draft.length})`}</button>
    </div>
  </div>;
});

export default KnowledgePicker;
