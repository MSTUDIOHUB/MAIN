// src/lib/chat/StreamingThoughtSummarizer.ts

export class StreamingThoughtSummarizer {
  /**
   * Generates a concise, single-line heuristic summary of a long thinking stream.
   * Extracts action patterns, decision tokens, or file paths without using an LLM.
   */
  static thoughtToSummary(thought: string, maxChars: number = 100, language: "zh" | "en" = "zh"): string {
    if (!thought || !thought.trim()) {
      return language === "zh" ? "分析当前任务状态" : "Analyzing current task status";
    }

    const isZh = language === "zh";
    const cleaned = thought.replace(/<\/?[a-zA-Z]+>/g, "").trim();

    // 1. Check for file path mentions or actions
    const fileMatches = cleaned.match(/([\w.-]+\.(?:ts|tsx|js|jsx|css|json|md|py|rs|go|yml|yaml))/i);
    const hasWrite = /write|edit|modify|patch|update|写入|修改|编辑|更新/i.test(cleaned);
    const hasRead = /read|view|cat|inspect|读取|查看/i.test(cleaned);
    const hasCommand = /command|run|shell|execute|命令|执行|运行/i.test(cleaned);

    let summary = "";
    if (fileMatches) {
      const fileName = fileMatches[1];
      if (hasWrite) {
        summary = isZh 
          ? `计划修改文件 ${fileName}` 
          : `Planning to modify ${fileName}`;
      } else if (hasRead) {
        summary = isZh 
          ? `计划读取文件 ${fileName}` 
          : `Planning to read ${fileName}`;
      } else {
        summary = isZh 
          ? `分析相关文件 ${fileName}` 
          : `Analyzing file ${fileName}`;
      }
    } else if (hasCommand) {
      summary = isZh 
        ? "准备执行系统终端命令" 
        : "Preparing to execute shell command";
    } else {
      // Fallback: take the first sentence or first chunk
      const firstSentence = cleaned.split(/[。!.?\n]/)[0].trim();
      summary = firstSentence.slice(0, maxChars);
    }

    if (summary.length > maxChars) {
      summary = summary.slice(0, maxChars - 3) + "...";
    }

    return summary || (isZh ? "规划下一步实施步骤" : "Planning next implementation steps");
  }
}
