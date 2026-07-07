import { IconCheck, IconPlay, IconStop, IconClose } from "./Icons";
import type { GoalDefinition, GoalProgress } from "../lib/goalState";

interface GoalPanelProps {
  goal: GoalDefinition;
  progress: GoalProgress | null;
  status: string;
  language: "zh" | "en";
  themeMode: "light" | "dark" | "black";
  onPause: () => void;
  onResume: () => void;
  onStop: () => void;
}

export default function GoalPanel({
  goal,
  progress,
  status,
  language,
  themeMode,
  onPause,
  onResume,
  onStop,
}: GoalPanelProps) {
  const isLightTheme = themeMode === "light";
  const isBlackTheme = themeMode === "black";

  const iterations = progress?.iterations || [];

  const bgColor = isLightTheme ? "bg-[#ffffff]" : isBlackTheme ? "bg-[#000000]" : "bg-[#111112]";
  const textColor = isLightTheme ? "text-[#18181b]" : "text-[#d4d4d8]";
  const mutedTextColor = isLightTheme ? "text-[#71717a]" : "text-[#a1a1aa]";
  const borderColor = isLightTheme ? "border-[#e4e4e7]" : "border-[#27272a]";
  const headerBgColor = isLightTheme ? "bg-[#f4f4f5]" : "bg-[#18181b]";

  return (
    <div className={`flex h-full flex-col ${bgColor} ${textColor}`}>
      {/* Header */}
      <div className={`shrink-0 border-b p-4 ${borderColor} ${headerBgColor}`}>
        <div className="flex items-center justify-between mb-2">
          <h2 className="text-sm font-semibold truncate" title={goal.objective}>
            {goal.objective}
          </h2>
          <span className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-medium border ${
            status === "active" ? "bg-green-100 text-green-700 border-green-200" :
            status === "paused" ? "bg-yellow-100 text-yellow-700 border-yellow-200" :
            status === "completed" ? "bg-blue-100 text-blue-700 border-blue-200" :
            "bg-red-100 text-red-700 border-red-200"
          }`}>
            {status.toUpperCase()}
          </span>
        </div>

        {/* Stats */}
        <div className={`grid grid-cols-2 gap-4 text-xs mt-3 ${mutedTextColor}`}>
          <div>
            <div className="mb-1">{language === "zh" ? "迭代次数" : "Iterations"}</div>
            <div className="font-mono text-sm font-medium">
              {progress?.currentIteration || 0} / {goal.iterationBudget}
            </div>
          </div>
          <div>
            <div className="mb-1">{language === "zh" ? "Token 使用" : "Tokens Used"}</div>
            <div className="font-mono text-sm font-medium">
              {progress?.totalTokensUsed?.toLocaleString() || 0}
            </div>
          </div>
        </div>

        {/* Controls */}
        <div className="flex items-center gap-2 mt-4">
          {status === "active" ? (
            <button
              onClick={onPause}
              className="flex items-center justify-center gap-1.5 flex-1 py-1.5 rounded-md border border-yellow-500/50 bg-yellow-500/10 text-yellow-600 text-xs font-semibold hover:bg-yellow-500/20 transition-colors"
            >
              <IconStop className="mr-1.5 h-4 w-4" />
              {language === "zh" ? "暂停" : "Pause"}
            </button>
          ) : (
            <button
              onClick={onResume}
              disabled={status === "completed" || status === "failed"}
              className="flex items-center justify-center gap-1.5 flex-1 py-1.5 rounded-md border border-green-500/50 bg-green-500/10 text-green-600 text-xs font-semibold hover:bg-green-500/20 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <IconPlay className="w-3.5 h-3.5" />
              {language === "zh" ? "继续" : "Resume"}
            </button>
          )}
          <button
            onClick={onStop}
            className="flex items-center justify-center gap-1.5 flex-1 py-1.5 rounded-md border border-red-500/50 bg-red-500/10 text-red-600 text-xs font-semibold hover:bg-red-500/20 transition-colors"
          >
            <IconStop className="w-3.5 h-3.5" />
            {language === "zh" ? "停止" : "Stop"}
          </button>
        </div>
      </div>

      {/* Iterations Log */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        <h3 className={`text-xs font-bold uppercase tracking-wider ${mutedTextColor}`}>
          {language === "zh" ? "执行日志" : "Execution Log"}
        </h3>
        
        {iterations.length === 0 ? (
          <div className={`text-xs text-center py-8 ${mutedTextColor}`}>
            {language === "zh" ? "暂无迭代记录" : "No iterations yet"}
          </div>
        ) : (
          <div className="space-y-4">
            {[...iterations].reverse().map((iter) => (
              <div key={iter.index} className={`rounded-lg border p-3 ${borderColor} ${isLightTheme ? "bg-[#fafafa]" : "bg-[#18181b]"}`}>
                <div className="flex items-center justify-between mb-2">
                  <span className="text-xs font-bold text-blue-500">
                    Iteration #{iter.index}
                  </span>
                  <span className={`text-[10px] uppercase font-bold tracking-wider px-1.5 py-0.5 rounded bg-black/10 dark:bg-white/10 ${mutedTextColor}`}>
                    {iter.phase}
                  </span>
                </div>
                
                {iter.summary && (
                  <p className="text-xs leading-relaxed mb-3 whitespace-pre-wrap">
                    {iter.summary}
                  </p>
                )}

                {(iter.filesModified.length > 0 || iter.testsRun.length > 0) && (
                  <div className={`text-[11px] mt-2 pt-2 border-t space-y-2 ${borderColor} ${mutedTextColor}`}>
                    {iter.filesModified.length > 0 && (
                      <div>
                        <span className="font-medium mr-1">{language === "zh" ? "修改了:" : "Modified:"}</span>
                        {iter.filesModified.length} {language === "zh" ? "个文件" : "files"}
                      </div>
                    )}
                    {iter.testsRun.length > 0 && (
                      <div className="flex items-start gap-1">
                        <span className="font-medium shrink-0">{language === "zh" ? "验证:" : "Verified:"}</span>
                        <div className="break-all font-mono">
                          {iter.testsRun.map(cmd => (
                            <div key={cmd} className="truncate" title={cmd}>{cmd}</div>
                          ))}
                        </div>
                        {iter.testsPassed !== null && (
                          <span className={`ml-auto shrink-0 ${iter.testsPassed ? "text-green-500" : "text-red-500"}`}>
                            {iter.testsPassed ? <IconCheck className="w-3.5 h-3.5" /> : <IconClose className="w-3.5 h-3.5" />}
                          </span>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
