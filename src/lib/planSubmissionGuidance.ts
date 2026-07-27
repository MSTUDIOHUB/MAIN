export type PlanSubmissionGuidanceLanguage = "zh" | "en";

/**
 * Recovery prompts must not choose a wire format independently. The latest
 * Plan authoring contract is injected after tool-surface resolution and is the
 * single authority for native-tool versus text-envelope submission.
 */
export function buildPlanSubmissionGuidance(
  language: PlanSubmissionGuidanceLanguage,
): string {
  return language === "zh"
    ? "严格遵循最新注入的 `[PLAN AUTHORING CONTRACT]`，通过其中声明的当前提交入口提交一个完整 typed graph；不要改用其他提交格式。"
    : "Follow the latest injected `[PLAN AUTHORING CONTRACT]` exactly and submit one complete typed graph through its declared active submission transport; do not switch formats.";
}
