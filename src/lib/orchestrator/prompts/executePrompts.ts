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
        "MAIN 会收起目录遍历等宽泛探索，但保留定向 read_file、源码定位、修改以及有限命令/浏览器验证。",
        "请先根据已有工具结果判断任务是否已经完成：如果完成，直接输出最终总结并停止，不要再调用工具。",
        "需要精确当前源码时使用 read_file，不要改用 cat/sed/head/tail 绕过文件版本与范围缓存；同版本同窗口返回 stub 后必须转向下一真实动作。",
        "已有定位信息足够时，请直接用 replace_in_file/apply_patch 做最小修改，或运行一次验证命令；不要重新开始宽泛搜索。",
        "不要在文件和上下文都未变化时重复同一读取窗口、重复同一验证或继续修改同一目标而没有新证据；修改后的复读和新的必要范围属于有效验证。",
      ].join("\n")
    : [
        `This Execute turn has reached ${iteration}/${maxIterations} tool-loop iterations and is approaching the safety boundary.`,
        "MAIN withholds broad directory exploration while retaining targeted read_file, source targeting, mutation, finite commands, and browser validation.",
        "First decide from existing tool results whether the task is already complete. If it is complete, output the final summary and stop without more tools.",
        "Use read_file when exact current source is needed; do not bypass versioned range caching with cat/sed/head/tail. After the same active version/window returns a stub, move to the next real action.",
        "When existing targeting evidence is sufficient, directly apply the smallest replace_in_file/apply_patch edit or run one validation command; do not restart broad exploration.",
        "Do not repeat the same read window or validation while file/context state is unchanged, or keep editing the same target without new evidence; a post-mutation reread or a newly required range is valid verification.",
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
    !/(?:已|已经|成功)|\b(?:done|fixed|implemented|patched|updated|completed|verified|passed)\b/i.test(normalized);
  return !looksLikeProposalOnly;
}

export function buildReadOnlyPermissionHardRecoveryPrompt(language: "zh" | "en", workflowMode: "chat" | "edit" | "plan"): string {
  if (language === "en") {
    return [
      "The user already allowed read-only inspection for this session, but the previous turn still did not make useful tool progress.",
      "Do not ask for permission again and do not narrate a future read.",
      workflowMode === "plan"
        ? "If the evidence is sufficient, output visible `<proposed_plan>` for MAIN runtime to materialize; if one fact is still missing, call exactly one targeted read/search tool now. Reuse cached content instead of rereading it."
        : "If you need evidence, call one targeted read/search tool now. If the target was already cached, reuse the existing content and move to the next real action: patch/write, run a finite command, browser validation, or state the exact blocker.",
    ].join("\n");
  }
  return [
    "用户已经允许本会话的只读检查，但上一轮仍没有产生有效工具进展。",
    "不要再次询问许可，也不要只描述接下来要读取什么。",
    workflowMode === "plan"
      ? "如果证据已经足够，直接输出可见 `<proposed_plan>` 交由 MAIN runtime 物化；如果只缺一个事实，现在只调用一次定向读取/搜索工具。仅当同一未变化版本和范围仍在上下文时复用缓存；不同范围或文件已变化时可以读取。"
      : "如果还需要证据，现在只调用一次定向读取/搜索工具。仅当同一未变化版本和范围仍在上下文时复用缓存；不同范围或文件已变化时可以读取，然后进入写入/替换、有限命令、浏览器验证或精确阻塞。",
  ].join("\n");
}
