import { useMemo } from "react";
import {
  IconChevronRight,
  IconCode,
  IconFileText,
  IconPlay,
  IconRefresh,
  IconStop,
} from "./Icons";
import { useAppStore } from "../store/useAppStore";
import type { TaskCenterTask, TaskCenterTaskStatus } from "../lib/taskCenter";

const STATUS_TONE: Record<TaskCenterTaskStatus, string> = {
  inbox: "border-[#3f3f46] bg-[#09090b] text-[#a1a1aa]",
  ready: "border-[rgba(96,165,250,0.25)] bg-[rgba(96,165,250,0.12)] text-[#93c5fd]",
  running: "border-[rgba(251,191,36,0.25)] bg-[rgba(251,191,36,0.12)] text-[#fbbf24]",
  needs_review: "border-[rgba(168,85,247,0.28)] bg-[rgba(168,85,247,0.14)] text-[#d8b4fe]",
  blocked: "border-[rgba(251,113,133,0.26)] bg-[rgba(251,113,133,0.12)] text-[#fda4af]",
  done: "border-[rgba(52,211,153,0.25)] bg-[rgba(52,211,153,0.12)] text-[#86efac]",
  failed: "border-[rgba(248,113,113,0.28)] bg-[rgba(248,113,113,0.12)] text-[#fca5a5]",
  canceled: "border-[#3f3f46] bg-[#09090b] text-[#71717a]",
};

function formatTime(value?: number | null): string {
  if (!value) return "";
  return new Date(value).toLocaleString();
}

function getStatusLabel(status: TaskCenterTaskStatus, language: "zh" | "en"): string {
  const zh: Record<TaskCenterTaskStatus, string> = {
    inbox: "收件箱",
    ready: "待执行",
    running: "执行中",
    needs_review: "待审批",
    blocked: "已阻塞",
    done: "完成",
    failed: "失败",
    canceled: "已取消",
  };
  const en: Record<TaskCenterTaskStatus, string> = {
    inbox: "Inbox",
    ready: "Ready",
    running: "Running",
    needs_review: "Needs Review",
    blocked: "Blocked",
    done: "Done",
    failed: "Failed",
    canceled: "Canceled",
  };
  return (language === "zh" ? zh : en)[status];
}

function taskCanRun(task: TaskCenterTask): boolean {
  return task.status === "inbox" || task.status === "ready" || task.status === "failed" || task.status === "blocked";
}

export default function TaskCenterPanel() {
  const language = useAppStore((s) => s.config.language === "en" ? "en" : "zh");
  const taskCenter = useAppStore((s) => s.taskCenter);
  const agentStatus = useAppStore((s) => s.agentStatus);
  const selectTask = useAppStore((s) => s.selectTaskCenterTask);
  const updateStatus = useAppStore((s) => s.updateTaskCenterTaskStatus);
  const runTask = useAppStore((s) => s.runTaskCenterTask);
  const runNext = useAppStore((s) => s.runNextTaskCenterTask);
  const cancelTask = useAppStore((s) => s.cancelTaskCenterTask);
  const retryTask = useAppStore((s) => s.retryTaskCenterTask);

  const copy = {
    title: language === "zh" ? "任务中枢" : "Task Center",
    queue: language === "zh" ? "任务队列" : "Queue",
    detail: language === "zh" ? "任务详情" : "Task Details",
    empty: language === "zh" ? "在任务中枢模式下发送一条指令，会先创建可追踪任务卡。" : "Send an instruction in Task Center mode to create a trackable task card.",
    runNext: language === "zh" ? "运行下一个" : "Run Next",
    markReady: language === "zh" ? "设为待执行" : "Mark Ready",
    run: language === "zh" ? "执行" : "Run",
    plan: language === "zh" ? "仅生成计划" : "Plan Only",
    retry: language === "zh" ? "重试" : "Retry",
    cancel: language === "zh" ? "取消" : "Cancel",
    source: language === "zh" ? "来源" : "Source",
    context: language === "zh" ? "上下文" : "Context",
    runs: language === "zh" ? "运行记录" : "Runs",
    noLogs: language === "zh" ? "还没有运行日志。" : "No run logs yet.",
    scheduler: language === "zh" ? "调度器" : "Scheduler",
    writeLock: language === "zh" ? "写入锁" : "Write Lock",
    integrations: language === "zh" ? "外部来源" : "External Sources",
    disabled: language === "zh" ? "未启用" : "Disabled",
    enabled: language === "zh" ? "已启用" : "Enabled",
  };

  const counts = useMemo(() => {
    return taskCenter.tasks.reduce<Record<TaskCenterTaskStatus, number>>((acc, task) => {
      acc[task.status] += 1;
      return acc;
    }, {
      inbox: 0,
      ready: 0,
      running: 0,
      needs_review: 0,
      blocked: 0,
      done: 0,
      failed: 0,
      canceled: 0,
    });
  }, [taskCenter.tasks]);

  const selectedTask =
    taskCenter.tasks.find((task) => task.id === taskCenter.selectedTaskId) ||
    taskCenter.tasks[0] ||
    null;
  const selectedRuns = selectedTask
    ? taskCenter.runs.filter((run) => run.taskId === selectedTask.id).sort((a, b) => b.startedAt - a.startedAt)
    : [];
  const selectedRun = selectedRuns[0] || null;
  const isBusy = agentStatus === "running" || agentStatus === "pending_review";

  return (
    <div className="flex h-full min-h-0 flex-col bg-[#050505]">
      <div className="shrink-0 border-b border-[#18181b] px-4 py-3">
        <div className="flex items-center justify-between gap-3">
          <div>
            <div className="text-[12px] font-semibold text-[#e4e4e7]">{copy.title}</div>
            <div className="mt-1 text-[11px] text-[#71717a]">
              {taskCenter.tasks.length} {language === "zh" ? "个任务" : "tasks"} · {counts.running + counts.needs_review} {language === "zh" ? "个活跃" : "active"}
            </div>
          </div>
          <button
            onClick={runNext}
            disabled={isBusy || taskCenter.scheduler.paused || taskCenter.tasks.length === 0}
            className="inline-flex h-8 items-center gap-1.5 rounded-md border border-[rgba(96,165,250,0.25)] bg-[rgba(96,165,250,0.12)] px-3 text-[11px] font-medium text-[#bfdbfe] transition-colors hover:bg-[rgba(96,165,250,0.2)] disabled:cursor-not-allowed disabled:opacity-40"
          >
            <IconPlay className="h-3.5 w-3.5" />
            {copy.runNext}
          </button>
        </div>
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-[minmax(220px,0.9fr)_minmax(260px,1.1fr)]">
        <div className="min-h-0 border-r border-[#18181b]">
          <div className="flex h-full min-h-0 flex-col">
            <div className="shrink-0 px-3 py-2 text-[11px] font-semibold uppercase tracking-[0.16em] text-[#71717a]">{copy.queue}</div>
            <div className="min-h-0 flex-1 space-y-2 overflow-y-auto px-3 pb-4">
              {taskCenter.tasks.length === 0 && (
                <div className="rounded-lg border border-dashed border-[#27272a] p-4 text-[12px] leading-6 text-[#71717a]">
                  {copy.empty}
                </div>
              )}
              {taskCenter.tasks.map((task) => {
                const active = selectedTask?.id === task.id;
                return (
                  <button
                    key={task.id}
                    onClick={() => selectTask(task.id)}
                    className={`w-full rounded-lg border px-3 py-2 text-left transition-colors ${
                      active
                        ? "border-[rgba(124,58,237,0.45)] bg-[rgba(124,58,237,0.12)]"
                        : "border-[#18181b] bg-[#09090b] hover:border-[#27272a] hover:bg-[#111113]"
                    }`}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0 flex-1">
                        <div className="line-clamp-2 text-[12px] font-medium leading-5 text-[#e4e4e7]">{task.title}</div>
                        <div className="mt-1 truncate text-[11px] text-[#71717a]">{formatTime(task.updatedAt)}</div>
                      </div>
                      <span className={`shrink-0 rounded-full border px-2 py-0.5 text-[10px] ${STATUS_TONE[task.status]}`}>
                        {getStatusLabel(task.status, language)}
                      </span>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        </div>

        <div className="min-h-0 overflow-y-auto px-4 py-4">
          {!selectedTask ? (
            <div className="rounded-lg border border-dashed border-[#27272a] p-5 text-[12px] leading-6 text-[#71717a]">
              {copy.empty}
            </div>
          ) : (
            <div className="space-y-4">
              <section className="rounded-lg border border-[#18181b] bg-[#09090b] p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-[13px] font-semibold leading-6 text-[#f4f4f5]">{selectedTask.title}</div>
                    <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-[#71717a]">
                      <span>{copy.source}: {selectedTask.source.provider}</span>
                      <span>·</span>
                      <span>{language === "zh" ? `尝试 ${selectedTask.attempts} 次` : `${selectedTask.attempts} attempt(s)`}</span>
                    </div>
                  </div>
                  <span className={`shrink-0 rounded-full border px-2 py-0.5 text-[10px] ${STATUS_TONE[selectedTask.status]}`}>
                    {getStatusLabel(selectedTask.status, language)}
                  </span>
                </div>
                <div className="mt-3 whitespace-pre-wrap rounded-md border border-[#18181b] bg-[#050505] p-3 text-[12px] leading-6 text-[#c7c7ce]">
                  {selectedTask.prompt}
                </div>

                <div className="mt-3 flex flex-wrap justify-end gap-2">
                  {(selectedTask.status === "inbox" || selectedTask.status === "failed" || selectedTask.status === "blocked") && (
                    <button
                      onClick={() => updateStatus(selectedTask.id, "ready")}
                      className="inline-flex h-8 items-center gap-1.5 rounded-md border border-[#27272a] bg-[#050505] px-3 text-[11px] text-[#d4d4d8] hover:bg-[#18181b]"
                    >
                      <IconChevronRight className="h-3.5 w-3.5" />
                      {copy.markReady}
                    </button>
                  )}
                  {(selectedTask.status === "failed" || selectedTask.status === "blocked") && (
                    <button
                      onClick={() => retryTask(selectedTask.id)}
                      className="inline-flex h-8 items-center gap-1.5 rounded-md border border-[#27272a] bg-[#050505] px-3 text-[11px] text-[#d4d4d8] hover:bg-[#18181b]"
                    >
                      <IconRefresh className="h-3.5 w-3.5" />
                      {copy.retry}
                    </button>
                  )}
                  {taskCanRun(selectedTask) && (
                    <>
                      <button
                        onClick={() => runTask(selectedTask.id, "plan")}
                        disabled={isBusy}
                        className="inline-flex h-8 items-center gap-1.5 rounded-md border border-[rgba(168,85,247,0.25)] bg-[rgba(168,85,247,0.12)] px-3 text-[11px] text-[#ddd6fe] hover:bg-[rgba(168,85,247,0.2)] disabled:cursor-not-allowed disabled:opacity-40"
                      >
                        <IconFileText className="h-3.5 w-3.5" />
                        {copy.plan}
                      </button>
                      <button
                        onClick={() => runTask(selectedTask.id, "execute")}
                        disabled={isBusy}
                        className="inline-flex h-8 items-center gap-1.5 rounded-md bg-[linear-gradient(135deg,var(--accent,#7c3aed),#2563eb)] px-3 text-[11px] font-semibold text-white disabled:cursor-not-allowed disabled:opacity-40"
                      >
                        <IconCode className="h-3.5 w-3.5" />
                        {copy.run}
                      </button>
                    </>
                  )}
                  {(selectedTask.status === "running" || selectedTask.status === "needs_review" || selectedTask.status === "ready" || selectedTask.status === "inbox") && (
                    <button
                      onClick={() => cancelTask(selectedTask.id)}
                      className="inline-flex h-8 items-center gap-1.5 rounded-md border border-[#3f3f46] bg-[#050505] px-3 text-[11px] text-[#fca5a5] hover:bg-[#18181b]"
                    >
                      <IconStop className="h-3.5 w-3.5" />
                      {copy.cancel}
                    </button>
                  )}
                </div>
              </section>

              <section className="rounded-lg border border-[#18181b] bg-[#09090b] p-4">
                <div className="text-[12px] font-semibold text-[#e4e4e7]">{copy.context}</div>
                <div className="mt-2 flex flex-wrap gap-2 text-[11px] text-[#a1a1aa]">
                  {[...selectedTask.contextMentions, ...selectedTask.attachedFiles].map((item) => (
                    <span key={item} className="rounded-md border border-[#27272a] bg-[#050505] px-2 py-1">{item}</span>
                  ))}
                  {selectedTask.imageCount > 0 && (
                    <span className="rounded-md border border-[#27272a] bg-[#050505] px-2 py-1">
                      {selectedTask.imageCount} {language === "zh" ? "张图片" : "image(s)"}
                    </span>
                  )}
                  {selectedTask.contextMentions.length === 0 && selectedTask.attachedFiles.length === 0 && selectedTask.imageCount === 0 && (
                    <span className="text-[#71717a]">{language === "zh" ? "无额外上下文。" : "No extra context."}</span>
                  )}
                </div>
              </section>

              <section className="rounded-lg border border-[#18181b] bg-[#09090b] p-4">
                <div className="flex items-center justify-between">
                  <div className="text-[12px] font-semibold text-[#e4e4e7]">{copy.runs}</div>
                  {selectedRun && <span className="text-[11px] text-[#71717a]">{formatTime(selectedRun.startedAt)}</span>}
                </div>
                <div className="mt-3 space-y-2">
                  {!selectedRun && <div className="text-[12px] text-[#71717a]">{copy.noLogs}</div>}
                  {selectedRun?.logs.map((log) => (
                    <div key={log.id} className="flex gap-2 rounded-md border border-[#18181b] bg-[#050505] px-3 py-2 text-[11px] leading-5">
                      <span className={log.level === "error" ? "text-[#f87171]" : log.level === "warning" ? "text-[#fbbf24]" : "text-[#71717a]"}>
                        {new Date(log.at).toLocaleTimeString()}
                      </span>
                      <span className="min-w-0 flex-1 text-[#c7c7ce]">{log.message}</span>
                    </div>
                  ))}
                </div>
              </section>

              <section className="rounded-lg border border-[#18181b] bg-[#09090b] p-4">
                <div className="text-[12px] font-semibold text-[#e4e4e7]">{copy.scheduler}</div>
                <div className="mt-2 grid grid-cols-2 gap-2 text-[11px] text-[#a1a1aa]">
                  <div className="rounded-md border border-[#18181b] bg-[#050505] px-3 py-2">
                    {copy.writeLock}: {taskCenter.scheduler.writeLockTaskId ? language === "zh" ? "占用中" : "Locked" : language === "zh" ? "空闲" : "Free"}
                  </div>
                  <div className="rounded-md border border-[#18181b] bg-[#050505] px-3 py-2">
                    {language === "zh" ? "自动领取" : "Auto claim"}: {taskCenter.scheduler.autoStart ? copy.enabled : copy.disabled}
                  </div>
                </div>
              </section>

              <section className="rounded-lg border border-[#18181b] bg-[#09090b] p-4">
                <div className="text-[12px] font-semibold text-[#e4e4e7]">{copy.integrations}</div>
                <div className="mt-2 grid grid-cols-3 gap-2 text-[11px]">
                  {(["linear", "github", "feishu"] as const).map((key) => {
                    const enabled = taskCenter.integrations[key].enabled && !!taskCenter.integrations[key].token;
                    return (
                      <div key={key} className="rounded-md border border-[#18181b] bg-[#050505] px-3 py-2">
                        <div className="font-medium capitalize text-[#d4d4d8]">{key}</div>
                        <div className={enabled ? "mt-1 text-[#86efac]" : "mt-1 text-[#71717a]"}>
                          {enabled ? copy.enabled : copy.disabled}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </section>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
