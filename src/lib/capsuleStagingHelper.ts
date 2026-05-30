/**
 * Agent 意图 Capsule 动态第一人称提炼与二次优化辅助逻辑
 */

/**
 * 校验一段文本是否为符合 Capsule 路由要求的拟人对话式第一人称意图说明
 */
export function isIdleCapsuleNarration(text: string): boolean {
  const raw = String(text || "").replace(/\s+/g, " ").trim();
  if (!raw) return false;
  return (
    /等待(?:您|你)?(?:的)?(?:下一步)?(?:指令|命令)/.test(raw) ||
    /随时准备(?:开始|继续)?(?:新的)?(?:探索|修改|工作)/.test(raw) ||
    /await(?:ing)?\s+(?:your\s+)?(?:next\s+)?(?:instruction|instructions|command|commands)/i.test(raw) ||
    /ready\s+to\s+begin\s+(?:new\s+)?(?:exploration|modification|modifications|changes|work)/i.test(raw) ||
    /ready\s+for\s+(?:your\s+)?(?:next\s+)?(?:instruction|instructions|command|commands)/i.test(raw)
  );
}

export function isConversationalFirstPersonNarration(text: string): boolean {
  const raw = String(text || "").trim();
  if (!raw) return false;
  if (isIdleCapsuleNarration(raw)) return false;

  // 如果包含富文本结构或长度过长，说明是正式结论/回答，不作为可收拢隐藏的第一人称中间进度叙述
  if (raw.length > 300) return false;
  if (/\||-\s+\[[ x]\]/i.test(raw)) return false;

  // 2. 检查是否具备典型的第一人称意图、计划或动作引导特征
  const hasFirstPersonZh = /(?:我|正在|接下来|为了|准备|计划|先进行|等待|请确认|我已)/.test(raw);
  const hasFirstPersonEn = /\b(?:I|we|I'm|we're|going to|next|waiting for|please|analyzing|verifying|preparing|ready to)\b/i.test(raw);

  return hasFirstPersonZh || hasFirstPersonEn;
}

/**
 * 辅助函数：截取并清洁 Thought（思路）文本的最后一句话，用于动态心流反馈
 */
function cleanAndExtractLastThoughtSentence(content: string, language: "zh" | "en"): string {
  const raw = String(content || "").trim();
  if (!raw) return "";

  // 移除所有 Markdown 语法、JSON 字符串以及长路径干扰
  const sanitized = raw
    .replace(/```[\s\S]*?```/g, "")
    .replace(/\{[\s\S]*?\}/g, "")
    .replace(/\[[\s\S]*?\]/g, "")
    .replace(/[a-zA-Z0-9_\-./\\]+\.[a-zA-Z0-9]{1,8}/g, "...")
    .trim();

  // 根据中英文分句并过滤空句
  const sentences = sanitized
    .split(/(?:[。！？\n]+|(?:\.|\?|\!)\s+)/)
    .map((s) => s.trim())
    .filter((s) => s.length > 4 && s.length < 80 && !/^[.\s]*$/.test(s));

  if (sentences.length === 0) return "";

  const lastSentence = sentences[sentences.length - 1];

  // 确保语气读起来像第一人称在规划
  if (language === "zh") {
    if (/^(?:我|正在|准备|思考|分析|确认|检查|接下来)/.test(lastSentence)) {
      return lastSentence;
    }
    return `我正在思考：${lastSentence}`;
  } else {
    if (/^(?:I|we|thinking|analyzing|verifying|checking|preparing)/i.test(lastSentence)) {
      return lastSentence;
    }
    return `I am thinking about ${lastSentence.charAt(0).toLowerCase() + lastSentence.slice(1)}`;
  }
}

/**
 * 辅助函数：格式化并清洁模型输出的动态 intentSummary 或 why 字段
 */
function cleanDynamicIntent(text: string): string {
  return String(text || "")
    .replace(/^执行|^进行|^调用|^使用/g, "")
    .replace(/^(?:读取|查看|探索|搜索|修改|写入|运行|验证)\s*[A-Za-z0-9_\-./\\]+\s*(?:以|来)/g, "")
    .replace(/[。！？，、,.!?;:]\s*$/g, "")
    .trim();
}

/**
 * 动态第一人称状态机二次优化渲染器 (deriveDynamicFirstPersonText)
 * 拒绝死模板，根据运行工具的意图、流式 Thought 分句以及当前计划主题动态合成拟人句。
 */
export function deriveDynamicFirstPersonText(
  turn: any,
  blocks: any[],
  agentStatus: string,
  language: "zh" | "en"
): string {
  const isZh = language === "zh";

  // 1. 工具运行阶段的动态二次加工 (Active Running Tool)
  const runningTool = [...blocks]
    .reverse()
    .find((block) => block.type === "tool" && block.toolStatus === "running");

  if (runningTool) {
    const fileBasename = String(runningTool.target || runningTool.toolName || "")
      .split(/[/\\]/)
      .pop() || runningTool.toolName;

    const rawIntent = runningTool.intentSummary || runningTool.why || "";
    const cleanIntent = cleanDynamicIntent(rawIntent);

    const toolName = String(runningTool.toolName || "");
    const readTools = new Set(["read_file", "read_document", "list_directory", "glob_search", "grep_search", "repo_map_status", "repo_map_search", "repo_map_context", "repo_map_files", "repo_map_impact", "index_workspace_documents", "get_project_skeleton"]);
    const modifyTools = new Set(["write_file", "replace_in_file", "apply_text_edits", "delete_file"]);
    const commandTools = new Set(["execute_command", "run_command", "browser_evaluate", "send_pty_input"]);

    if (isZh) {
      if (readTools.has(toolName)) {
        return cleanIntent
          ? `我正在读取并探索 \`${fileBasename}\`，目的是：${cleanIntent}...`
          : `我正在读取并探索 \`${fileBasename}\` 文件，以获取准确的代码上下文信息...`;
      }
      if (modifyTools.has(toolName)) {
        return cleanIntent
          ? `我正在对 \`${fileBasename}\` 进行代码修改，以实现：${cleanIntent}...`
          : `我正在对 \`${fileBasename}\` 进行代码修改，以落实我们方案中商定的改动...`;
      }
      if (commandTools.has(toolName)) {
        return cleanIntent
          ? `我正在运行 \`${fileBasename}\` 验证命令，目的是：${cleanIntent}...`
          : `我正在运行 \`${fileBasename}\` 验证命令，确保修改后的代码能通过所有质量与测试标准...`;
      }
      return cleanIntent
        ? `我正在调用 \`${fileBasename}\` 工具，目的是：${cleanIntent}...`
        : `我正在调用 \`${fileBasename}\` 工具以安全高效地推进任务...`;
    } else {
      if (readTools.has(toolName)) {
        return cleanIntent
          ? `I am exploring \`${fileBasename}\` to: ${cleanIntent}...`
          : `I am exploring the \`${fileBasename}\` file to gather precise code context...`;
      }
      if (modifyTools.has(toolName)) {
        return cleanIntent
          ? `I am modifying \`${fileBasename}\` to: ${cleanIntent}...`
          : `I am modifying the \`${fileBasename}\` file to apply the agreed-upon changes...`;
      }
      if (commandTools.has(toolName)) {
        return cleanIntent
          ? `I am running \`${fileBasename}\` to: ${cleanIntent}...`
          : `I am running the verification command \`${fileBasename}\` to ensure all quality and test standards are met...`;
      }
      return cleanIntent
        ? `I am using \`${fileBasename}\` to: ${cleanIntent}...`
        : `I am using the \`${fileBasename}\` tool to safely and efficiently move the task forward...`;
    }
  }

  // 2. 计划与审批阶段的动态二次加工 (Planning & Awaiting Approval)
  const isAwaitingApproval = agentStatus === "pending_review" || turn?.status === "awaiting_approval";
  if (isAwaitingApproval) {
    const planTopic = (turn?.title && !/^(?:Untitled|New Run|Session)/i.test(turn.title))
      ? turn.title
      : (isZh ? "当前的模块修复" : "the current module changes");

    return isZh
      ? `我已为您生成了关于【${planTopic}】的完整修改计划，正在等待您的审批。批准后我将开始安全的自动代码修改流程...`
      : `I have generated the implementation plan for [${planTopic}] and am awaiting your approval to safely proceed with the code changes...`;
  }

  // 3. 等待用户选择/交互选项阶段 (Awaiting Input Options)
  const latestOptionBlock = [...blocks].reverse().find((block) =>
    block.type === "agent" &&
    Array.isArray(block.options) &&
    block.options.length > 0,
  );
  if (latestOptionBlock || turn?.status === "awaiting_input") {
    return isZh
      ? "我为您提供了几种解决方案，正在等待您的选择，这将决定我接下来的修改与优化方向..."
      : "I have provided a few options and am waiting for your choice to guide my next implementation steps...";
  }

  // 4. 流式思考与推理过程中的实时心流分句提炼 (Thought & Streaming)
  const streamingThought = [...blocks]
    .reverse()
    .find((block) => block.type === "thought" && block.isStreaming);

  if (streamingThought) {
    const dynamicExplanation = cleanAndExtractLastThoughtSentence(streamingThought.content || "", language);
    if (dynamicExplanation) {
      return dynamicExplanation;
    }
    return isZh
      ? "我正在深入分析当前工作区中的代码结构与报错日志，规划具体的实施方案..."
      : "I am deep in thought, analyzing the codebase to plan the best implementation approach...";
  }

  if (turn?.status === "planning") {
    return isZh
      ? "我正在梳理整体方案结构，准备为您起草一份周密可行的实施计划..."
      : "I am structuring the overall approach, preparing to draft a thorough implementation plan for you...";
  }

  const hasStreamingAgent = blocks.some((block) => block.type === "agent" && block.streaming);
  if (hasStreamingAgent) {
    return isZh
      ? "我正在为您整理详细的执行进展说明与下一步方案分析..."
      : "I am writing a detailed progress explanation and next steps analysis for you...";
  }

  // 5. 无明确运行信号时保持静默，避免把 idle 状态误当成模型反馈。
  return "";
}
