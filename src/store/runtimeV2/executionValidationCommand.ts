import { compactDebugString } from "../../lib/debugLog";
import { analyzeValidationCommand } from "../../lib/validationContract";

export interface RuntimeV2FiniteValidationRejection {
  readonly reasonCode: "finite_validation_contract_required";
  readonly rejectionReason: string;
  readonly message: string;
}

/** Validation execution requires a finite acceptance contract. Ordinary
 * shell actions use their own authorization path and cannot discharge this
 * validation debt merely because their process exits successfully. */
function validationCommandFixHint(rejectionReason: string): string {
  switch (rejectionReason) {
    case "pipeline_exit_status_ambiguous":
      return "修复建议：移除管道符及后续过滤命令（如 | tail、| head、| grep），直接运行验证命令以保留真实非零退出码。";
    case "non_fail_fast_connector":
      return "修复建议：不要使用 ; 或 || 连接多段命令，请拆分为单条命令或仅用 && 串联以确保 fail-fast。";
    case "unbounded_command_segment":
    case "no_validation_segment":
      return "修复建议：当前命令缺少有限验证入口。若工作区无独立测试/构建清单，请改用带明确失败断言的 inline_assertion（例如 python3 -c \"...; assert ...\" 或 node -e \"...; assert.ok(...)\"），切勿仅用 cat/grep/ls/wc 充当验收。";
    case "inline_assertion_missing_failure_semantics":
      return "修复建议：inline_assertion（python3 -c / node -e）必须在断言失败时返回非零退出码（显式包含 assert、sys.exit(1)、process.exit(1) 或 throw）。";
    default:
      return "修复建议：请提供可直接退出并反映通过/失败退出码的单条有限验证或 inline_assertion 命令。";
  }
}

export function finiteValidationCommandRejection(
  value: unknown,
): RuntimeV2FiniteValidationRejection | null {
  const command = String(value || "").trim();
  const analysis = analyzeValidationCommand(command);
  if (analysis.spec?.kind === "finite_command") return null;
  const rejectionReason = analysis.rejectionReason ||
    "no_validation_segment";
  const commandPreview = command ? compactDebugString(command, 140) : "";
  return {
    reasonCode: "finite_validation_contract_required",
    rejectionReason,
    message: [
      "验证阶段需要能以退出状态证明结果的有限 build、test、lint、typecheck 或 check 命令。",
      "cat、grep、sed、head、tail、wc 等只读检查只能补充观察，不能作为验收。",
      `当前命令未满足有限验证契约：${rejectionReason}${commandPreview ? `（命令：${commandPreview}）` : ""}。`,
      validationCommandFixHint(rejectionReason),
    ].join(" "),
  };
}
