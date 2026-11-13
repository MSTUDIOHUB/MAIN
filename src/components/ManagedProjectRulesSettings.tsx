import { useRef, useState } from "react";
import { useAppStore } from "../store/useAppStore";
import {
  commitProjectInitPreview,
  prepareProjectInitPreview,
  projectInitManagedBlockDigest,
  type ProjectInitPreview,
} from "../lib/projectInit";
import { projectInitIpcIo } from "../lib/projectInitIpc";
import ProjectInitReviewModal, { type ProjectInitReviewPhase } from "./ProjectInitReviewModal";
import ToggleSwitch from "./ToggleSwitch";

export default function ManagedProjectRulesSettings({ language, themeMode, busy }: {
  language: "en" | "zh";
  themeMode: "light" | "dark" | "black";
  busy: boolean;
}) {
  const workspace = useAppStore(state => state.currentWorkspace);
  const enabled = useAppStore(state => !!state.managedProjectRulesByWorkspace[workspace]);
  const reviewNeeded = useAppStore(state => !!state.managedProjectRulesReviewNeeded[workspace]);
  const [review, setReview] = useState<{
    workspace: string;
    phase: ProjectInitReviewPhase;
    preview: ProjectInitPreview | null;
    error?: string;
  } | null>(null);
  const request = useRef(0);
  const zh = language === "zh";
  const label = zh ? "自动更新项目规则摘要" : "Update project rules summary automatically";
  const beginReview = async () => {
    if (!workspace || busy) return;
    const id = ++request.current;
    setReview({ workspace, phase: "loading", preview: null });
    try {
      const preview = await prepareProjectInitPreview({
        command: "/rules --refresh",
        workspace,
        locale: language,
        io: projectInitIpcIo,
      });
      if (request.current === id) setReview({ workspace, phase: "review", preview });
    } catch (error) {
      if (request.current === id) setReview({ workspace, phase: "error", preview: null, error: String(error) });
    }
  };
  const confirm = async () => {
    const preview = review?.preview;
    const current = useAppStore.getState();
    if (!preview || review.phase !== "review" || busy || review.workspace !== current.currentWorkspace) return;
    const blockDigest = projectInitManagedBlockDigest(preview.proposed);
    if (!blockDigest) return;
    setReview({ ...review, phase: "committing" });
    try {
      const result = await commitProjectInitPreview({
        preview,
        currentWorkspaceIdentity: preview.workspaceIdentity,
        io: projectInitIpcIo,
      });
      if (result.status === "stale") {
        setReview({ ...review, phase: "error", error: "PROJECT_INIT_CONTENT_STALE" });
        return;
      }
      const latest = useAppStore.getState();
      if (latest.currentWorkspace === review.workspace) {
        latest.setManagedProjectRulesPreference(review.workspace, { blockDigest, locale: preview.locale });
        if (result.status === "committed") latest.bumpWorkspaceContentVersion();
        void latest.refreshInstructionAndHookState();
      }
      setReview(null);
    } catch (error) {
      setReview({ ...review, phase: "error", error: String(error) });
    }
  };
  return (
    <div className="flex items-start justify-between gap-4 border-t border-[#27272a] pt-5">
      <div>
        <p className="text-[13px] font-bold">{label}</p>
        <p className="mt-1 text-[12px] opacity-70">
          {workspace
            ? (zh ? "仅更新当前工作区 AGENTS.md 的 MAIN 受管区块。" : "Updates the MAIN-managed section of AGENTS.md in this workspace.")
            : (zh ? "打开工作区后可以设置。" : "Open a workspace to configure this option.")}
        </p>
        {enabled && reviewNeeded && (
          <button type="button" className="mt-1 text-[12px] underline" disabled={busy} onClick={() => void beginReview()}>
            {zh ? "审阅受管区块" : "Review managed section"}
          </button>
        )}
      </div>
      <ToggleSwitch checked={enabled} aria-label={label} disabled={!workspace || busy}
        onCheckedChange={next => {
          if (next) void beginReview();
          else useAppStore.getState().setManagedProjectRulesPreference(workspace, null);
        }} />
      {review && review.workspace === workspace && (
        <ProjectInitReviewModal language={language} themeMode={themeMode} phase={review.phase}
          preview={review.preview} errorMessage={review.error} onConfirm={confirm}
          confirmLabel={zh ? "确认并开启" : "Confirm and enable"}
          onRegenerate={beginReview} onCancel={() => { request.current++; setReview(null); }} />
      )}
    </div>
  );
}
