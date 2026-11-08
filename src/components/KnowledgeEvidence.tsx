import type { KnowledgeContextPacket } from "../lib/knowledgeReferences";

export default function KnowledgeEvidence({ packet, language }: { packet?: KnowledgeContextPacket; language: "zh" | "en" }) {
  if (!packet?.references.length) return null;
  const zh = language === "zh";
  const overview = packet.hits.some(hit => hit.retrievalKind === "source_overview");
  const omittedAll = !packet.hits.length && !!packet.omittedHits;
  const label = packet.state === "stale" ? (zh ? "资料已变化，请重新选择" : "Sources changed; select again")
    : packet.state === "error" ? (zh ? "资料检索失败" : "Source retrieval failed")
      : omittedAll ? (zh ? "资料片段超出本轮上下文预算" : "Source excerpts exceeded this Run's context budget")
        : packet.state === "no_hits" ? (zh ? "所选资料没有匹配片段" : "No matching excerpts in selected sources")
          : overview ? (zh ? "所选资料 · 有限开头概览" : "Selected source · limited opening overview")
            : (zh ? `本轮引用资料 · ${packet.hits.length} 个片段` : `Selected sources · ${packet.hits.length} excerpts`);
  const note = overview
    ? (zh ? "没有词面匹配，展示所选单篇资料的开头供继续读取。这不是检索命中，也不是全文总结。" : "No lexical match. This opening from the selected document supports further reading; it is not a search match or a complete summary.")
    : omittedAll ? (zh ? "本轮没有放入可引用的资料正文。请缩小所选范围或聚焦问题后重试。" : "No source text fits this Run. Narrow the selection or focus the question and try again.")
      : packet.state === "retrieved" ? "" : packet.note;
  return <details className="mt-2 max-w-full rounded-lg border px-3 py-2 text-xs" data-testid="knowledge-evidence"
    style={{ borderColor: "var(--surface-border)", background: "var(--surface-1)", color: "var(--surface-text)" }}>
    <summary className="cursor-pointer">{label}</summary>
    {note && <p className="mt-2 whitespace-pre-wrap opacity-75">{note}</p>}
    {!!packet.omittedHits && <p className="mt-2 opacity-75">{zh ? `另有 ${packet.omittedHits} 个片段因上下文预算省略，不能据此声称已读完整资料。` : `${packet.omittedHits} excerpts were omitted for the context budget; complete source coverage is unavailable.`}</p>}
    {packet.hits.map((hit, index) => <div key={`${hit.citation.chunkId}:${index}`} className="mt-2 border-t pt-2" style={{ borderColor: "var(--surface-border)" }} data-retrieval-kind={hit.retrievalKind}>
      <div className="font-medium">{hit.citation.sourceTitle || hit.citation.sourceId}{hit.citation.page != null ? ` · p.${hit.citation.page}` : ""}</div>
      <div className="mt-1 break-all text-[10px] opacity-70">{hit.citation.kbName || hit.citation.kbId} · {hit.citation.chunkId}</div>
      {hit.returnedCharRange && hit.totalChars != null && <p className="mt-1 text-[10px] opacity-75" data-testid="knowledge-returned-range">
        {zh ? "原片段字符" : "Original chunk characters"} {hit.returnedCharRange.start + 1}–{hit.returnedCharRange.end} / {hit.totalChars}
        {hit.complete === false ? (zh ? " · 部分内容" : " · partial content") : ""}
      </p>}
      {hit.sourceOverview && <p className="mt-1 text-[10px] opacity-75">{zh ? `索引共 ${hit.sourceOverview.totalChunks} 个分块，累计 ${hit.sourceOverview.totalChars} 字符（可能含重叠）` : `${hit.sourceOverview.totalChunks} indexed chunks, ${hit.sourceOverview.totalChars} characters including possible overlap`}</p>}
      {hit.sourceOverview?.nextChunkId && <p className="mt-1 break-all text-[10px] opacity-75" data-testid="knowledge-next-chunk">{zh ? "后续片段" : "Next chunk"}: {hit.sourceOverview.nextChunkId}</p>}
      {hit.citation.sourceUrl && /^https?:\/\//i.test(hit.citation.sourceUrl) && <a href={hit.citation.sourceUrl} target="_blank" rel="noreferrer" className="mt-1 block break-all underline">{hit.citation.sourceUrl}</a>}
      <p className="mt-2 max-h-48 overflow-y-auto whitespace-pre-wrap leading-relaxed">{hit.text}</p>
    </div>)}
  </details>;
}
