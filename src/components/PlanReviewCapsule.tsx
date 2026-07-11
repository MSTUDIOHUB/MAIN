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
  const titleTone = isLight ? "text-[#18181b]" : "text-[#f4f4f5]";
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
      className={`w-full rounded-xl border p-3 ${surface}`}
    >
      <div className="flex min-w-0 items-start gap-3">
        <span className="theme-plan-pill mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border">
          <IconFileText className="h-4 w-4" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className={`min-w-0 truncate text-[12px] font-semibold ${titleTone}`} title={request.title}>
              {request.title}
            </span>
            <span className="theme-plan-pill shrink-0 rounded-full border px-2 py-0.5 text-[10px]">
              {language === "zh" ? `计划待审核 · 修订 ${request.planRevision}` : `Plan review · revision ${request.planRevision}`}
            </span>
          </div>
          <div className={`mt-1 text-[11px] leading-5 ${secondaryTone}`}>
            {language === "zh"
              ? "请审阅当前计划产物；批准后会在同一回合创建新的执行 run。"
              : "Review the current Plan artifact. Approval starts a new execution run in the same turn."}
          </div>
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
        <button
          type="button"
          data-testid="plan-review-capsule-open"
          onClick={onOpenPlan}
          className={`rounded-lg border px-3 py-2 text-[11px] font-semibold transition-colors ${
            isLight
              ? "border-[#d4d4d8] bg-white text-[#334155] hover:border-[var(--accent)] hover:text-[#111827]"
              : "border-[#3f3f46] bg-[#09090b] text-[#d4d4d8] hover:border-[var(--accent)] hover:bg-[#18181b] hover:text-white"
          }`}
        >
          {language === "zh" ? "审阅计划" : "Review Plan"}
        </button>
        <button
          type="button"
          data-testid="plan-review-capsule-approve"
          onClick={onApprove}
          className="theme-plan-primary inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-[11px] font-semibold"
        >
          <IconCheck className="h-3.5 w-3.5" />
          {language === "zh" ? "批准执行" : "Approve & Execute"}
        </button>
      </div>
    </div>
  );
}
