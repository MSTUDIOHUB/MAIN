import { IconCheck, IconFileText } from "./Icons";
import type { PlanReviewActionRequest } from "../lib/actionRequest";

interface PlanReviewCapsuleProps {
  request: PlanReviewActionRequest;
  language: "zh" | "en";
  themeMode: "light" | "dark" | "black";
  onOpenPlan: () => void;
  onApprove: () => void;
}

/**
 * Compact, typed projection of a formal Plan review request. The PlanPanel is
 * still the canonical document surface; this checkpoint only makes the active
 * request discoverable and resolves the exact immutable request identity.
 */
export default function PlanReviewCapsule({
  request,
  language,
  themeMode,
  onOpenPlan,
  onApprove,
}: PlanReviewCapsuleProps) {
  const isLight = themeMode === "light";
  const isBlack = themeMode === "black";
  const surface = isLight
    ? "border-[rgba(15,23,42,0.12)] bg-[rgba(255,255,255,0.78)]"
    : isBlack
    ? "border-[#202026] bg-[#030304]"
    : "border-[#27272a] bg-[#09090b]";
  const secondaryTone = isLight ? "text-[#64748b]" : "text-[#a1a1aa]";

  return (
    <div
      data-testid="plan-review-capsule"
      data-action-kind="plan_review"
      data-session-key={request.sessionKey}
      data-turn-id={request.turnId}
      data-run-id={request.runId}
      data-request-id={request.requestId}
      data-plan-revision={String(request.planRevision)}
      data-artifact-hash={request.artifactHash}
      className={`w-full rounded-xl border p-4 ${surface}`}
    >
      <div className="flex min-w-0 flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 items-start gap-3">
          <span className="theme-plan-pill flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border">
            <IconFileText className="h-[18px] w-[18px]" />
          </span>
          <div className="min-w-0 flex-1 pt-0.5">
            <span className="theme-plan-pill inline-flex rounded-full border px-2.5 py-1 text-[11px] font-medium leading-none">
              {language === "zh" ? `计划待审核 · 修订 ${request.planRevision}` : `Plan review · revision ${request.planRevision}`}
            </span>
            <p className={`mt-2 text-left text-[12px] leading-5 ${secondaryTone}`}>
              {language === "zh"
                ? "请审阅当前计划；批准后将立即创建新的执行任务。"
                : "Review the current plan. Approval immediately starts a new execution run."}
            </p>
          </div>
        </div>
        <div className="flex w-full shrink-0 items-center gap-2 sm:w-auto sm:justify-end">
          <button
            type="button"
            data-testid="plan-review-capsule-open"
            onClick={onOpenPlan}
            className={`inline-flex h-10 flex-1 items-center justify-center whitespace-nowrap rounded-lg border px-4 text-[12px] font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-2 sm:flex-none ${
              isLight
                ? "border-[#d4d4d8] bg-white text-[#334155] hover:border-[var(--accent)] hover:text-[#111827] focus-visible:ring-offset-white"
                : "border-[#3f3f46] bg-[#09090b] text-[#d4d4d8] hover:border-[var(--accent)] hover:bg-[#18181b] hover:text-white focus-visible:ring-offset-[#09090b]"
            }`}
          >
            {language === "zh" ? "审阅计划" : "Review Plan"}
          </button>
          <button
            type="button"
            data-testid="plan-review-capsule-approve"
            onClick={onApprove}
            className={`theme-plan-primary inline-flex h-10 flex-1 items-center justify-center gap-1.5 whitespace-nowrap rounded-lg px-4 text-[12px] font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-2 sm:flex-none ${
              isLight ? "focus-visible:ring-offset-white" : "focus-visible:ring-offset-[#09090b]"
            }`}
          >
            <IconCheck className="h-4 w-4" />
            {language === "zh" ? "批准执行" : "Approve & Execute"}
          </button>
        </div>
      </div>
    </div>
  );
}
