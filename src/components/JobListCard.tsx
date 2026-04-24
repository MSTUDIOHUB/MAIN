import { useState } from "react";
import { IconChevronUp, IconChevronDown, IconCheck } from "./Icons";
import { useAppStore, useTheme } from "../store/useAppStore";
import type { JobItem } from "../store/useAppStore";

interface JobListCardProps {
  jobs: JobItem[];
}

export default function JobListCard({ jobs }: JobListCardProps) {
  const [expanded, setExpanded] = useState(true);
  const theme = useTheme();
  const language = useAppStore((s) => s.config.language);

  const doneCount = jobs.filter((j) => j.status === "completed").length;

  return (
    <div className="w-full max-w-3xl ml-9 mt-1 mb-2">
      <div className="bg-[#09090b] border border-[#27272a] rounded-lg shadow-sm overflow-hidden">
        {/* Header */}
        <button
          onClick={() => setExpanded(!expanded)}
          className="w-full flex items-center justify-between px-4 py-2.5 hover:bg-[#18181b] transition-colors"
        >
          <div className="flex items-center gap-2.5">
            <div className="flex flex-col gap-[3px]">
              <div className="w-3 h-[2px] rounded-full bg-[#71717a]" />
              <div className="w-3 h-[2px] rounded-full bg-[#71717a]" />
              <div className="w-3 h-[2px] rounded-full bg-[#71717a]" />
            </div>
            <span className="text-[13px] text-[#e4e4e7]">
              {language === "zh" ? "任务列表" : "Job List"} —{" "}
              <span className="text-[#a1a1aa]">
                {language === "zh" ? `已完成 ${doneCount}/${jobs.length}` : `${doneCount} of ${jobs.length} done`}
              </span>
            </span>
          </div>
          {expanded ? (
            <IconChevronUp className="w-3.5 h-3.5 text-[#71717a]" />
          ) : (
            <IconChevronDown className="w-3.5 h-3.5 text-[#71717a]" />
          )}
        </button>

        {/* Job list */}
        {expanded && (
          <div className="px-4 pb-3 space-y-1.5 border-t border-[#27272a] pt-2">
            {jobs.map((job) => {
              const isActive = job.status === "in_progress";
              const isDone = job.status === "completed";

              return (
                <div
                  key={job.id}
                  className="flex items-center justify-between py-1"
                >
                  <div className="flex items-center gap-2.5">
                    {/* Status dot */}
                    {isActive && (
                      <span
                        className="w-2 h-2 rounded-full shrink-0 animate-pulse"
                        style={{
                          backgroundColor: theme.accent,
                          boxShadow: `0 0 6px ${theme.light}`,
                        }}
                      />
                    )}
                    {isDone && (
                      <span
                        className="shrink-0"
                        style={{ color: theme.accent }}
                      >
                        <IconCheck className="w-3.5 h-3.5" />
                      </span>
                    )}
                    {job.status === "pending" && (
                      <span
                        className="w-2 h-2 rounded-full shrink-0"
                        style={{ backgroundColor: "#3f3f46" }}
                      />
                    )}

                    {/* Subject */}
                    <span
                      className={`text-[12px] leading-snug ${
                        isActive
                          ? "font-semibold"
                          : "text-[#a1a1aa]"
                      }`}
                      style={isActive ? { color: theme.light } : undefined}
                    >
                      #{job.id} {job.subject}
                    </span>
                  </div>

                  {/* Status label */}
                  <span
                    className="text-[11px] shrink-0 ml-3"
                    style={{
                      color: isActive
                        ? theme.accent
                        : isDone
                        ? theme.accent
                        : "#52525b",
                    }}
                  >
                    {isActive
                      ? language === "zh" ? "进行中" : "In progress"
                      : isDone
                      ? language === "zh" ? "完成" : "Done"
                      : language === "zh" ? "待办" : "Pending"}
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
