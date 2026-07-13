import { useEffect, useMemo, useState } from "react";
import {
  IconCheck,
  IconChevronDown,
  IconClose,
  IconEdit,
  IconGoal,
  IconPause,
  IconPlay,
  IconTrash,
} from "./Icons";
import {
  buildGoalProgressPercentage,
  buildGoalStatusLabel,
  normalizeGoalCriteria,
  type GoalDefinition,
  type GoalProgress,
  type GoalRuntimeSnapshot,
  type GoalStatus,
} from "../lib/goalState";
import {
  resolveGoalPresentationBehavior,
  resolveTurnPresentationLifecycle,
  type GoalPresentationTone,
  type TurnPresentationModel,
} from "../lib/turnPresentation";

interface GoalPanelProps {
  presentation?: TurnPresentationModel;
  goal: GoalDefinition;
  progress: GoalProgress | null;
  status: GoalStatus;
  runtime?: GoalRuntimeSnapshot | null;
  language: "zh" | "en";
  themeMode: "light" | "dark" | "black";
  onPause: () => void;
  onResume: () => void;
  onEdit: (objective: string) => boolean;
  onStop: () => void;
  onClose?: () => void;
}

const PHASE_LABELS = {
  plan: { zh: "规划下一步", en: "Planning" },
  execute: { zh: "执行中", en: "Executing" },
  observe: { zh: "收集证据", en: "Observing" },
  re_plan: { zh: "重新规划", en: "Re-planning" },
} as const;

function formatDuration(ms: number, language: "zh" | "en"): string {
  const totalMinutes = Math.max(0, Math.floor(ms / 60_000));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (language === "zh") return hours > 0 ? `${hours} 小时 ${minutes} 分钟` : `${minutes} 分钟`;
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
}

function presentationToneClass(tone: GoalPresentationTone): string {
  if (tone === "completed") return "goal-status-completed";
  if (tone === "failed") return "goal-status-failed";
  if (tone === "paused") return "goal-status-paused";
  return "goal-status-active";
}

export default function GoalPanel({
  presentation,
  goal,
  progress,
  status,
  runtime,
  language,
  onPause,
  onResume,
  onEdit,
  onStop,
  onClose,
}: GoalPanelProps) {
  const [now, setNow] = useState(Date.now());
  const [editing, setEditing] = useState(false);
  const [pendingEdit, setPendingEdit] = useState(false);
  const [draft, setDraft] = useState(goal.rawText || goal.objective);
  const [confirmClear, setConfirmClear] = useState(false);
  const resolvedProgress = runtime?.progress || progress;
  const resolvedGoal = runtime?.goal || goal;
  const criteria = useMemo(() => normalizeGoalCriteria(resolvedGoal), [resolvedGoal]);

  useEffect(() => {
    setDraft(resolvedGoal.rawText || resolvedGoal.objective);
    setEditing(false);
    setPendingEdit(false);
    setConfirmClear(false);
  }, [resolvedGoal.id, resolvedGoal.revision]);

  useEffect(() => {
    if (!pendingEdit || status !== "paused") return;
    setPendingEdit(false);
    setEditing(true);
  }, [pendingEdit, status]);

  useEffect(() => {
    if (status !== "active" && status !== "pausing") return;
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, [status]);

  const activeDurationMs = resolvedProgress?.usage
    ? resolvedProgress.usage.activeDurationMs + (
        resolvedProgress.usage.activeStartedAt ? Math.max(0, now - resolvedProgress.usage.activeStartedAt) : 0
      )
    : Math.max(0, now - resolvedGoal.createdAt);
  const progressPercentage = resolvedProgress
    ? buildGoalProgressPercentage(resolvedProgress, resolvedGoal)
    : 0;
  const evidence = resolvedProgress?.evidence || [];
  const latestVerification = [...evidence].reverse().find((entry) =>
    entry.kind === "test" || entry.kind === "build" || entry.kind === "browser" || entry.kind === "user_validation"
  );
  const currentMilestone = resolvedProgress?.milestones?.find((item) => item.id === resolvedProgress.currentMilestoneId)
    || resolvedProgress?.milestones?.find((item) => item.status === "in_progress")
    || null;
  const recentIterations = (resolvedProgress?.iterations || []).slice(-5).reverse();
  const blockers = recentIterations.flatMap((iteration) => iteration.unresolvedBlockers).filter(Boolean).slice(0, 5);
  const modifiedFiles = Array.from(new Set(
    (resolvedProgress?.iterations || []).flatMap((iteration) => iteration.filesModified),
  )).slice(0, 12);
  const phase = runtime?.phase || recentIterations[0]?.phase || "plan";
  const phaseLabel = PHASE_LABELS[phase][language];
  const resolvedLifecycle = presentation?.lifecycle || resolveTurnPresentationLifecycle(status);
  const presentationBehavior = resolveGoalPresentationBehavior({
    lifecycle: resolvedLifecycle,
    status: presentation?.status || status,
    actionKind: presentation?.actionKind,
  });
  const toneClass = presentationToneClass(presentationBehavior.tone);

  const beginEdit = () => {
    if (!presentationBehavior.canEdit) return;
    if (presentationBehavior.primaryAction === "pause") {
      setPendingEdit(true);
      onPause();
      return;
    }
    setEditing(true);
  };

  const saveEdit = () => {
    const next = draft.trim();
    if (!next) return;
    if (onEdit(next)) setEditing(false);
  };

  return (
    <section
      className="goal-popover"
      role="dialog"
      aria-modal="false"
      aria-labelledby="goal-popover-title"
      data-goal-status={status}
      data-presentation-tone={presentationBehavior.tone}
      data-turn-id={presentation?.turnId}
      data-run-id={presentation?.runId}
      data-request-id={presentation?.requestId}
      data-turn-lifecycle={resolvedLifecycle}
      data-action-kind={presentation?.actionKind}
      data-testid="goal-popover-panel"
    >
      <header className="goal-popover-header">
        <div className="goal-popover-heading">
          <span className={`goal-popover-icon ${toneClass}`} aria-hidden="true">
            <IconGoal className="h-4 w-4" />
          </span>
          <div className="min-w-0">
            <div id="goal-popover-title" className="goal-popover-eyebrow">
              {language === "zh" ? "持续目标" : "Persistent Goal"}
            </div>
            <div className={`goal-status-label ${toneClass}`}>
              {buildGoalStatusLabel(status, language)}
            </div>
          </div>
        </div>
        {onClose && (
          <button type="button" className="goal-icon-button" onClick={onClose} title={language === "zh" ? "关闭" : "Close"}>
            <IconClose className="h-4 w-4" />
          </button>
        )}
      </header>

      <div className="goal-popover-content">
        {editing ? (
          <div className="goal-edit-region">
            <label htmlFor="goal-objective-editor" className="goal-section-label">
              {language === "zh" ? "编辑目标" : "Edit goal"}
            </label>
            <textarea
              id="goal-objective-editor"
              data-testid="goal-objective-editor"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              rows={5}
              className="goal-objective-editor"
              autoFocus
            />
            <p className="goal-help-text">
              {language === "zh"
                ? "保存后会重新生成完成标准并使旧版本验证证据失效；目标保持暂停。"
                : "Saving regenerates completion criteria and invalidates prior-revision verification. The goal remains paused."}
            </p>
            <div className="goal-inline-actions">
              <button type="button" className="goal-action-button goal-action-primary" onClick={saveEdit} disabled={!draft.trim()}>
                <IconCheck className="h-3.5 w-3.5" />
                {language === "zh" ? "保存目标" : "Save goal"}
              </button>
              <button type="button" className="goal-action-button" onClick={() => { setDraft(resolvedGoal.rawText || resolvedGoal.objective); setEditing(false); }}>
                {language === "zh" ? "取消" : "Cancel"}
              </button>
            </div>
          </div>
        ) : (
          <>
            <div className="goal-objective-row">
              <p className="goal-objective" title={resolvedGoal.rawText || resolvedGoal.objective}>
                {resolvedGoal.rawText || resolvedGoal.objective}
              </p>
              {presentationBehavior.canEdit && (
                <button
                  type="button"
                  className="goal-icon-button"
                  onClick={beginEdit}
                  disabled={pendingEdit}
                  title={language === "zh" ? "编辑目标" : "Edit goal"}
                  data-testid="goal-edit-button"
                >
                  <IconEdit className="h-4 w-4" />
                </button>
              )}
            </div>

            <div className="goal-summary-grid">
              <div><span>{language === "zh" ? "当前阶段" : "Phase"}</span><strong>{phaseLabel}</strong></div>
              <div><span>{language === "zh" ? "完成进度" : "Progress"}</span><strong>{progressPercentage}%</strong></div>
              <div><span>{language === "zh" ? "有效运行" : "Active time"}</span><strong>{formatDuration(activeDurationMs, language)}</strong></div>
              <div><span>{language === "zh" ? "模型轮次" : "Model rounds"}</span><strong>{resolvedProgress?.usage?.modelIterations || 0}</strong></div>
            </div>

            {currentMilestone && (
              <div className="goal-current-milestone">
                <span className="goal-section-label">{language === "zh" ? "当前里程碑" : "Current milestone"}</span>
                <p>{currentMilestone.text}</p>
              </div>
            )}

            <div className="goal-section">
              <div className="goal-section-title">
                <span>{language === "zh" ? "完成标准" : "Definition of done"}</span>
                <span>{criteria.filter((item) => item.status === "satisfied").length}/{criteria.length}</span>
              </div>
              <div className="goal-criteria-list">
                {criteria.map((criterion) => (
                  <div key={criterion.id} className="goal-criterion-row" data-status={criterion.status}>
                    <span className="goal-criterion-marker">
                      {criterion.status === "satisfied" ? <IconCheck className="h-3 w-3" /> : null}
                    </span>
                    <span>{criterion.text}</span>
                  </div>
                ))}
              </div>
            </div>

            <div className="goal-verification-row">
              <span className="goal-section-label">{language === "zh" ? "最近验证" : "Latest verification"}</span>
              {latestVerification ? (
                <span className={latestVerification.status === "failed" ? "goal-verification-failed" : "goal-verification-passed"}>
                  {latestVerification.status === "failed" ? (language === "zh" ? "失败" : "Failed") : (language === "zh" ? "通过" : "Passed")}
                  {latestVerification.target ? ` · ${latestVerification.target}` : ""}
                </span>
              ) : (
                <span className="goal-muted">{language === "zh" ? "尚无验证证据" : "No verification evidence yet"}</span>
              )}
            </div>

            {(runtime?.pauseReason || resolvedProgress?.pauseReason) && (
              <div className="goal-notice" data-tone={presentationBehavior.tone === "failed" ? "danger" : "warning"}>
                {runtime?.pauseReason || resolvedProgress?.pauseReason}
              </div>
            )}

            <details className="goal-details">
              <summary>
                <span>{language === "zh" ? "运行详情" : "Run details"}</span>
                <IconChevronDown className="h-4 w-4" />
              </summary>
              <dl className="goal-detail-list">
                <div><dt>{language === "zh" ? "证据" : "Evidence"}</dt><dd>{evidence.length}</dd></div>
                <div><dt>Token</dt><dd>{resolvedProgress?.totalTokensUsed?.toLocaleString() || 0}{resolvedProgress?.estimatedTokens ? " ~" : ""}</dd></div>
                <div><dt>{language === "zh" ? "内部续跑" : "Continuations"}</dt><dd>{resolvedProgress?.totalIterationsUsed || 0}</dd></div>
                <div><dt>{language === "zh" ? "修改文件" : "Modified files"}</dt><dd>{modifiedFiles.length}</dd></div>
              </dl>
              {blockers.length > 0 && (
                <div className="goal-detail-section">
                  <span className="goal-section-label">{language === "zh" ? "阻塞" : "Blockers"}</span>
                  {blockers.map((blocker, index) => <p key={`${blocker}-${index}`}>{blocker}</p>)}
                </div>
              )}
              {recentIterations.length > 0 && (
                <div className="goal-detail-section">
                  <span className="goal-section-label">{language === "zh" ? "最近进展" : "Recent progress"}</span>
                  {recentIterations.map((iteration) => (
                    <p key={iteration.index}><strong>#{iteration.index}</strong> {iteration.summary || (language === "zh" ? "无摘要" : "No summary")}</p>
                  ))}
                </div>
              )}
            </details>
          </>
        )}
      </div>

      {!editing && (
        <footer className="goal-popover-actions">
          {presentationBehavior.primaryAction === "pause" ? (
            <button type="button" className="goal-action-button goal-action-primary" onClick={onPause} disabled={presentationBehavior.primaryActionPending} data-testid="goal-pause-button">
              <IconPause className="h-3.5 w-3.5" />
              {presentationBehavior.primaryActionPending ? (language === "zh" ? "正在暂停" : "Pausing") : (language === "zh" ? "暂停" : "Pause")}
            </button>
          ) : presentationBehavior.canResume ? (
            <button type="button" className="goal-action-button goal-action-primary" onClick={onResume} data-testid="goal-resume-button">
              <IconPlay className="h-3.5 w-3.5" />
              {language === "zh" ? "继续" : "Resume"}
            </button>
          ) : null}

          {confirmClear ? (
            <div className="goal-clear-confirm" data-testid="goal-clear-confirm">
              <p>{language === "zh" ? "只清除目标跟踪，不会回滚文件修改。" : "This clears goal tracking and does not revert file changes."}</p>
              <button type="button" className="goal-action-button goal-action-danger" onClick={onStop}>
                <IconTrash className="h-3.5 w-3.5" />
                {language === "zh" ? "确认清除" : "Clear goal"}
              </button>
              <button type="button" className="goal-action-button" onClick={() => setConfirmClear(false)}>{language === "zh" ? "取消" : "Cancel"}</button>
            </div>
          ) : (
            <button type="button" className="goal-action-button goal-action-danger-muted" onClick={() => setConfirmClear(true)} data-testid="goal-clear-button">
              <IconTrash className="h-3.5 w-3.5" />
              {language === "zh" ? "清除" : "Clear"}
            </button>
          )}
        </footer>
      )}
    </section>
  );
}
