import { useEffect, useId, useRef } from "react";
import { createPortal } from "react-dom";
import type { PlanReviewActionRequest } from "../lib/actionRequest";
import MarkdownRenderer from "./MarkdownRenderer";

export default function PlanApprovalDialog({ request, markdown, language, onClose, onApprove }: {
  request: PlanReviewActionRequest;
  markdown: string;
  language: "zh" | "en";
  onClose: () => void;
  onApprove: (request: PlanReviewActionRequest) => void;
}) {
  const zh = language === "zh";
  const dialogRef = useRef<HTMLDialogElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const descriptionId = useId();

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const opener = document.activeElement;
    dialog.showModal();
    closeRef.current?.focus();
    return () => {
      dialog.close();
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
    };
  }, []);

  const button = "rounded-lg border px-3 py-2 text-xs font-semibold focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2";
  return createPortal(
    <dialog ref={dialogRef} aria-labelledby={titleId} aria-describedby={descriptionId} data-testid="plan-approval-dialog"
      data-request-id={request.requestId} data-artifact-hash={request.artifactHash}
      className="fixed inset-0 m-auto w-[calc(100%-2rem)] max-w-4xl overflow-hidden rounded-xl border p-0 shadow-2xl backdrop:bg-black/65"
      style={{ borderColor: "var(--surface-border)", background: "var(--surface-1)", color: "var(--surface-text)" }}
      onCancel={event => { event.preventDefault(); onClose(); }}>
      <div className="flex max-h-[85vh] flex-col">
        <header className="border-b px-5 py-4" style={{ borderColor: "var(--surface-border)" }}>
          <h2 id={titleId} className="text-sm font-semibold">{zh ? "审阅计划" : "Review plan"}</h2>
          <p id={descriptionId} className="mt-1 text-xs opacity-80">
            {zh ? `批准修订 ${request.planRevision} 后，MAIN 将开始执行以下计划。` : `Approving revision ${request.planRevision} starts execution of the plan below.`}
          </p>
        </header>
        <div className="min-h-0 overflow-y-auto px-5 py-4">
          <MarkdownRenderer content={markdown} sourceId={`plan-review:${request.requestId}`} />
        </div>
        <footer className="flex flex-wrap justify-end gap-2 border-t px-5 py-3" style={{ borderColor: "var(--surface-border)" }}>
          <button ref={closeRef} type="button" className={button} style={{ borderColor: "var(--surface-border)" }} onClick={onClose}>{zh ? "稍后审阅" : "Review later"}</button>
          <button type="button" className={`${button} theme-plan-primary`} onClick={() => onApprove(request)}>{zh ? "批准执行" : "Approve & execute"}</button>
        </footer>
      </div>
    </dialog>, document.body,
  );
}
