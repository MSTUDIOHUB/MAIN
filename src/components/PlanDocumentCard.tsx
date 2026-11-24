import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { readPlanDocument } from "../lib/ipc";
import type { PlanDocumentRef } from "../lib/planDocuments";
import { formatPlanSubmissionDiagnostics, formatSavedPlanDraftForDisplay, type PlanDraftRecord } from "../lib/planDrafts";
import MarkdownRenderer from "./MarkdownRenderer";


export default function PlanDocumentCard({ reference, draft, language, inlineMarkdown, onReviewRules, onReviewPlan, onCompleteValidation, continuationDisabled = false }: {
  reference?: PlanDocumentRef | null;
  draft?: PlanDraftRecord | null;
  language: "zh" | "en";
  inlineMarkdown?: string;
  onCompleteValidation?: (supplement?: string) => Promise<boolean>;
  continuationDisabled?: boolean;
  onReviewRules?: () => void;
  onReviewPlan?: () => void;
}) {
  const zh = language === "zh";
  const [opened, setOpened] = useState(false);
  const [markdown, setMarkdown] = useState("");
  const [error, setError] = useState(false);
  const generation = useRef(0);
  const continuationGeneration = useRef(0);
  const [completing, setCompleting] = useState(false);
  const [completionError, setCompletionError] = useState(false);
  const [showSupplement, setShowSupplement] = useState(false);
  const [supplement, setSupplement] = useState("");
  const supplementId = useId();
  useEffect(() => {
    generation.current++;
    continuationGeneration.current++;
    setOpened(false);
    setMarkdown("");
    setError(false);
    setCompleting(false);
    setCompletionError(false);
    setShowSupplement(false);
    setSupplement("");
    return () => { generation.current++; continuationGeneration.current++; };
  }, [reference?.owner.sessionKey, reference?.owner.sessionEpoch, reference?.owner.turnId, reference?.documentId, reference?.revision, reference?.contentHash]);
  useEffect(() => {
    if (!opened) return;
    const handler = (event: KeyboardEvent) => { if (event.key === "Escape") setOpened(false); };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [opened]);
  if (!reference) return null;
  const open = async () => {
    const current = ++generation.current;
    setOpened(true); setError(false); setMarkdown("");
    try { const result = await readPlanDocument(reference); if (generation.current === current) setMarkdown(result.markdown); }
    catch { if (generation.current === current) setError(true); }
  };
  const completeValidation = async (answer?: string) => {
    if (!onCompleteValidation || completing || continuationDisabled) return;
    const current = continuationGeneration.current;
    setCompleting(true); setCompletionError(false);
    try {
      const accepted = await onCompleteValidation(answer);
      if (continuationGeneration.current === current) {
        setCompletionError(!accepted);
        if (accepted) {
          setShowSupplement(false);
          setSupplement("");
        }
      }
    } catch { if (continuationGeneration.current === current) setCompletionError(true); }
    finally { if (continuationGeneration.current === current) setCompleting(false); }
  };
  const buttonClass = "rounded border px-2 py-1 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 disabled:cursor-not-allowed disabled:opacity-50";
  const buttonStyle = { borderColor: "var(--surface-border)", outlineColor: "var(--surface-text)" };
  const displayMarkdown = (content: string) => draft ? formatSavedPlanDraftForDisplay(content, draft) : content;
  return <>
    <div data-testid="plan-document-card" data-plan-readiness={draft ? "draft" : "document"} className="mt-3 rounded-lg border px-3 py-2 text-left text-xs" style={{ borderColor: "var(--surface-border)", color: "var(--surface-text)", background: "var(--surface-1)" }}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="min-w-0 flex-1 truncate">{reference.title} · v{reference.revision}</span>
        {!draft && onReviewPlan ? (
          <button type="button" className={`${buttonClass} theme-plan-primary`} style={buttonStyle} onClick={onReviewPlan}>{zh ? "审阅并批准" : "Review & approve"}</button>
        ) : !inlineMarkdown && (
          <button type="button" className={buttonClass} style={buttonStyle} onClick={() => void open()}>{zh ? "查看文档" : "View document"}</button>
        )}
        {draft && onCompleteValidation && <button type="button" className={buttonClass} style={buttonStyle} disabled={completing || continuationDisabled}
          aria-expanded={showSupplement} aria-controls={supplementId} onClick={() => setShowSupplement(!showSupplement)}>
          {zh ? "补全验证" : "Complete validation"}
        </button>}
        {reference.kind === "rules_draft" && onReviewRules && <button type="button" className={buttonClass} style={buttonStyle} onClick={onReviewRules}>{zh ? "审阅项目规则" : "Review project rules"}</button>}
      </div>
      {draft && <div data-testid="plan-draft-diagnostics" className="mt-2 border-t pt-2" style={{ borderColor: "var(--surface-border)" }}>
        <strong>{zh ? "草稿 · 待补全验证" : "Draft · validation needed"}</strong>
        <ul className="mt-1 list-disc space-y-1 pl-4">{formatPlanSubmissionDiagnostics(draft.diagnostics, language).map(copy => <li key={copy}>{copy}</li>)}</ul>
        {onCompleteValidation && <p className="mt-2 opacity-80">{zh ? "点击「补全验证」说明怎样才算通过，或请 MAIN 继续核实。" : "Open Complete validation to describe what should pass or ask MAIN to investigate."}</p>}
      </div>}
      {draft && showSupplement && <form id={supplementId} className="mt-3 space-y-2" onSubmit={event => {
        event.preventDefault();
        const answer = supplement.trim();
        if (answer) void completeValidation(answer);
      }}>
        <label htmlFor={`${supplementId}-answer`} className="block font-semibold">{zh ? "你希望如何确认结果达标？" : "How should we check the result?"}</label>
        <p id={`${supplementId}-hint`} className="opacity-80">{zh ? "可以描述预期结果、人工检查步骤或已有测试，也可以说明是否同意新增自动检查。" : "Describe the expected result, a manual check, or an existing test. You can also say whether MAIN may add an automated check."}</p>
        <textarea id={`${supplementId}-answer`} aria-describedby={`${supplementId}-hint`} rows={3} value={supplement} autoFocus
          onChange={event => setSupplement(event.target.value)} disabled={completing || continuationDisabled}
          className="w-full rounded border px-2 py-1.5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
          style={{ ...buttonStyle, background: "var(--surface-1)", color: "var(--surface-text)" }} />
        <div className="flex flex-wrap gap-2">
          <button type="submit" className={`${buttonClass} theme-plan-primary`} style={buttonStyle} disabled={!supplement.trim() || completing || continuationDisabled}>
            {completing ? (zh ? "正在核对…" : "Checking…") : (zh ? "提交并继续" : "Submit & continue")}
          </button>
          <button type="button" className={buttonClass} style={buttonStyle} disabled={completing || continuationDisabled} onClick={() => void completeValidation()}>
            {zh ? "请 MAIN 继续核实" : "Ask MAIN to investigate"}
          </button>
        </div>
      </form>}
      {completionError && <p role="alert" className="mt-2">{zh ? "无法继续此版本草稿。请确认当前会话和文档未被修改，然后重试。" : "Could not continue this draft revision. Check the current session and document, then retry."}</p>}
    </div>
    {inlineMarkdown && <div className="px-1 pt-4"><MarkdownRenderer content={displayMarkdown(inlineMarkdown)} sourceId={`plan-panel:${reference.documentId}:${reference.revision}`} /></div>}
    {opened && createPortal(<div className="fixed inset-0 z-[150] flex items-center justify-center bg-black/60 p-5" onMouseDown={event => { if (event.target === event.currentTarget) setOpened(false); }}>
      <section role="dialog" aria-modal="true" aria-label={reference.title} className="flex max-h-[90vh] w-full max-w-4xl flex-col overflow-hidden rounded-xl border shadow-2xl" style={{ borderColor: "var(--surface-border)", color: "var(--surface-text)", background: "var(--surface-1)" }}>
        <header className="flex items-center gap-3 border-b px-5 py-3" style={{ borderColor: "var(--surface-border)" }}><strong className="min-w-0 flex-1 truncate">{reference.title}</strong><button type="button" onClick={() => setOpened(false)}>{zh ? "关闭" : "Close"}</button></header>
        <div className="overflow-y-auto p-5">{error ? <p role="alert">{zh ? "无法读取此版本文档，请检查文件是否被移动或修改。" : "Could not read this document revision. Check whether its file was moved or changed."}</p> : markdown ? <MarkdownRenderer content={displayMarkdown(markdown)} sourceId={`plan-doc:${reference.documentId}:${reference.revision}`} /> : <p role="status">{zh ? "读取中…" : "Loading…"}</p>}</div>
        <footer className="border-t px-5 py-2 text-[10px] break-all opacity-60" style={{ borderColor: "var(--surface-border)" }}>{reference.path}</footer>
      </section>
    </div>, document.body)}
  </>;
}
