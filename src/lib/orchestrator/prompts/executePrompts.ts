export function buildHiddenThoughtOnlyContinuationPrompt(language: "zh" | "en", consecutiveNoToolCount: number): string {
  return language === "zh"
    ? [
        `上一条回复只有后台思考，没有给用户可见结论（第 ${consecutiveNoToolCount} 次）。`,
        "你已经读取/搜索了上下文；现在必须直接输出面向用户的 Markdown 结论。",
        "不要继续只返回 thinking/analysis 标签；除非真的缺少关键证据，否则不要再读同一批文件。",
        "结论至少包含：是否已经实现、哪些证据支持、仍缺什么或下一步。",
      ].join("\n")
    : [
        `The previous reply only contained hidden thinking and no user-visible conclusion (${consecutiveNoToolCount} time).`,
        "You have already read/searched the context; now output a user-visible Markdown conclusion.",
        "Do not return only thinking/analysis tags again. Do not reread the same files unless a key fact is still missing.",
        "Include at least: whether it is implemented, supporting evidence, and what is still missing or next.",
      ].join("\n");
}

export function buildExecuteConvergencePrompt(language: "zh" | "en", iteration: number, maxIterations: number): string {
  return language === "zh"
    ? [
        `本轮 Execute 已进行 ${iteration}/${maxIterations} 轮工具循环，接近安全边界。`,
        "MAIN 会临时收窄工具面：宽泛读取和搜索都会被收起，只保留小补丁/写入工具以及有限命令或浏览器验证。",
        "请先根据已有工具结果判断任务是否已经完成：如果完成，直接输出最终总结并停止，不要再调用工具。",
        "如果 read_file 当前不可用，不要继续请求 read_file，也不要改用 cat/sed/head/tail 通过 shell 读取文件。",
        "如果 grep_search/get_file_outline 已经给出足够定位信息，请直接用 replace_in_file/apply_patch 做最小修改，或运行一次验证命令；不要再调用新的搜索/泛读工具。",
        "不要重复读取、重复验证或继续改同一个目标而没有新证据。",
      ].join("\n")
    : [
        `This Execute turn has reached ${iteration}/${maxIterations} tool-loop iterations and is approaching the safety boundary.`,
        "MAIN will temporarily narrow the tool surface: broad reads and searches are withheld, leaving small patch/write tools plus finite command or browser validation.",
        "First decide from existing tool results whether the task is already complete. If it is complete, output the final summary and stop without more tools.",
        "If read_file is unavailable, do not keep requesting read_file and do not switch to cat/sed/head/tail shell file reads.",
        "If grep_search/get_file_outline already provide enough location context, directly apply the smallest replace_in_file/apply_patch edit or run one validation command; do not call new search or broad read tools.",
        "Do not repeat reads, repeat validation, or keep editing the same target without new evidence.",
    ].join("\n");
}

export function looksLikePlanCompletionClaim(text: string): boolean {
  const normalized = String(text || "").replace(/\s+/g, " ").trim();
  if (!normalized) return false;
  return (
    /(?:全部|所有|全[部都]?|已|已经).{0,24}(?:完成|满足|通过)|(?:任务|证据).{0,16}(?:全部|全都).{0,16}(?:完成|满足|通过)|\b\d+\s*\/\s*\d+\b.{0,24}(?:完成|complete|completed|done|satisfied|passed)/i.test(normalized) ||
    /(?:all|every).{0,40}(?:task|evidence|item).{0,40}(?:complete|completed|done|satisfied|passed)|(?:complete|completed|done|satisfied).{0,40}(?:all|every).{0,40}(?:task|evidence|item)/i.test(normalized)
  );
}

export function looksLikeOperationCompletionClaim(text: string): boolean {
  const normalized = String(text || "").replace(/\s+/g, " ").trim();
  if (!normalized) return false;
  const hasCompletionClaim =
    /(?:已|已经|现已|刚刚|成功).{0,24}(?:修复|修改|实现|更新|写入|生成|执行|完成|验证|通过)|(?:修复|修改|实现|更新|写入|生成|执行|验证).{0,16}(?:完成|好了|成功|通过)|(?:done|fixed|implemented|patched|updated|completed|wrote|created|generated|ran|verified|passed)\b/i.test(normalized);
  if (!hasCompletionClaim) return false;
  const looksLikeProposalOnly =
    /(?:方案|建议|计划|将会|可以|应该|准备|下一步|如果|待|需要用户|是否|proposal|plan|suggest|would|will|should|can|could|next step|ready to|once)/i.test(normalized) &&
    !/(?:已|已经|成功|done|fixed|implemented|patched|updated|completed|verified|passed)\b/i.test(normalized);
  return !looksLikeProposalOnly;
}

export function looksLikeExecutionReplanningText(text: string): boolean {
  const normalized = String(text || "").replace(/\s+/g, " ").trim();
  if (normalized.length < 240) return false;
  const hasPlanShape =
    /(?:修复方案|实现方案|执行方案|实施步骤|下一步|计划|方案|建议|Proposal|Implementation Plan|Execution Plan|Next steps?)/i.test(normalized);
  const hasFutureAction =
    /(?:将|会|建议|可以|应该|需要|下一步|准备|开始|执行|修改|修复|实现|验证|will|would|should|can|could|need to|next|propose|recommend|start|execute|modify|fix|implement|verify)/i.test(normalized);
  const hasConcreteWork =
    /(?:src\/|\.tsx?|\.jsx?|\.py|\.rs|\.go|\.json|\.md|read_file|write_file|replace_in_file|run_command|browser_evaluate|文件|代码|接口|组件|测试|验证|file|code|component|test|validation)/i.test(normalized);
  return hasPlanShape && hasFutureAction && hasConcreteWork && !looksLikeOperationCompletionClaim(normalized);
}

export function buildExecuteCompletionEvidencePrompt(language: "zh" | "en", retryCount: number): string {
  if (language === "en") {
    return [
      "The previous reply claimed the operation was complete, but MAIN has no real tool evidence for this execution turn.",
      "Do not repeat the completion claim. Start real tool actions now: inspect the relevant files, write or patch files if needed, run the necessary command/verification, then summarize only after tool results exist.",
      retryCount > 1 ? "This is a repeated failure. If you cannot perform the operation, stop and state the exact blocker instead of claiming success." : "",
    ].filter(Boolean).join("\n");
  }
  return [
    "上一条回复声称操作已完成，但 MAIN 没有看到本轮执行的真实工具证据。",
    "不要重复完成声明。现在必须开始真实工具操作：读取相关文件，必要时写入或打补丁，运行必要命令/验证，然后只能基于工具结果总结。",
    retryCount > 1 ? "这已经是重复失败。如果无法执行，请明确说明具体阻塞，不要声称成功。" : "",
  ].filter(Boolean).join("\n");
}

export function buildExecuteReplanningEvidencePrompt(language: "zh" | "en", retryCount: number): string {
  if (language === "en") {
    return [
      "The user already approved execution for this turn, but the previous reply produced another plan or explanation instead of real tool evidence.",
      "Do not re-plan or output explanatory text. Start the smallest necessary real tool action now by issuing a tool call directly: `replace_in_file`, `apply_patch`, or `write_file`.",
      retryCount > 1 ? "This is a repeated failure. Stop with a concrete blocker if no real action is possible." : "",
    ].filter(Boolean).join("\n");
  }
  return [
    "用户已经批准本轮执行，但上一条回复又输出了新的方案或解释文本，没有产生真实工具证据。",
    "不要重新规划，请勿在聊天框中继续输出解释文本。现在必须直接发起工具调用（Tool Call）：使用 `replace_in_file`、`apply_patch` 或 `write_file` 修改工作区文件、运行命令或进行验证。",
    retryCount > 1 ? "这已经是重复失败。如果无法真实执行，请直接给出具体阻塞，不要继续输出方案。" : "",
  ].filter(Boolean).join("\n");
}

export function buildReadOnlyPermissionHardRecoveryPrompt(language: "zh" | "en", workflowMode: "chat" | "edit" | "plan"): string {
  if (language === "en") {
    return [
      "The user already allowed read-only inspection for this session, but the previous turn still did not make useful tool progress.",
      "Do not ask for permission again and do not narrate a future read.",
      workflowMode === "plan"
        ? "If the evidence is sufficient, output a visible `<proposed_plan>` for runtime validation and materialization; if one fact is still missing, call exactly one targeted read/search tool now. If the target was already cached, reuse the existing content instead of rereading it."
        : "If you need evidence, call one targeted read/search tool now. If the target was already cached, reuse the existing content and move to the next real action: patch/write, run a finite command, browser validation, or state the exact blocker.",
    ].join("\n");
  }
  return [
    "用户已经允许本会话的只读检查，但上一轮仍没有产生有效工具进展。",
    "不要再次询问许可，也不要只描述接下来要读取什么。",
    workflowMode === "plan"
      ? "如果证据已经足够，直接输出可见 `<proposed_plan>` 交给 runtime 校验和物化；如果只缺一个事实，现在只调用一次定向读取/搜索工具。目标已缓存时复用已有内容，不要重复读取。"
      : "如果还需要证据，现在只调用一次定向读取/搜索工具。目标已缓存时复用已有内容，并进入下一个真实动作：写入/替换、运行有限命令、浏览器验证，或说明精确阻塞。",
  ].join("\n");
}
