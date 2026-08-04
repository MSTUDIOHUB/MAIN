import type { RuntimeV2MutationRecoveryExcerpt } from "./correctiveMutationPolicy";

export function runtimeV2MutationLeaseRejectionReason(input: {
  readonly toolName: string;
  readonly unexpectedTargets: readonly string[];
  readonly leaseTargets: readonly string[];
  readonly recoveryExcerpt?: RuntimeV2MutationRecoveryExcerpt | null;
}): string {
  const visibleTargets = new Set(input.leaseTargets);
  const missingTargets = input.unexpectedTargets.filter(
    (target) => !visibleTargets.has(target),
  );
  if (missingTargets.length > 0) {
    return [
      "MUTATION_SOURCE_NOT_VISIBLE:",
      `修改前必须先读取当前请求中尚不可见的目标：${missingTargets.join(", ")}。`,
    ].join(" ");
  }
  if (input.toolName === "replace_in_file") {
    const source = input.recoveryExcerpt;
    return [
      "REPLACE_SEARCH_TEXT_NOT_VISIBLE:",
      "search_text 与当前请求中已经可见的版本化源码不完全匹配。",
      "上一修改没有执行，工作区没有因此发生变化。请从下面的当前源码中复制最小且唯一的精确 search_text，再提交范围更小的修改。",
      source
        ? [
            `CURRENT_VERSIONED_SOURCE target=${JSON.stringify(source.target)} version=${JSON.stringify(source.version)} lines=${source.startLine}-${source.endLine}`,
            "---CURRENT SOURCE START---",
            source.content,
            "---CURRENT SOURCE END---",
          ].join("\n")
        : "当前请求没有可安全重放的相关片段；只读取确实缺失的精确范围。",
    ].join(" ");
  }
  return [
    "MUTATION_SOURCE_RANGE_NOT_VISIBLE:",
    `拟修改内容未被当前请求中的版本化源码安全覆盖：${input.unexpectedTargets.join(", ") || "未解析目标"}。`,
  ].join(" ");
}
