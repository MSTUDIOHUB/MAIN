import { unityValidationInvocations } from "../../lib/validationContract";
import { isUnmanagedUnityVerification, projectEditorPlayModeFilter, verifiedProjectEditorPlayModeResult, verifiedUnityValidationResult } from "../../lib/unityValidation";

export function unityValidationToolTimeoutMs(toolName: string, args: Record<string, unknown>): number | undefined {
  if (toolName !== "run_command") return;
  const [invocation] = unityValidationInvocations(String(args.command || ""));
  if (invocation) return invocation.kind === "batch" ? 300_000 : (invocation.timeoutSeconds + 10) * 1_000;
}

/** Interpret only the native result contract owned by this tool. User file
 * content, MCP payloads and diagnostic prose do not carry execution status. */
export function runtimeV2StructuredToolOutcome(toolName: string, output: unknown, args: Record<string, unknown> = {}, authority?: unknown): {
  readonly status: "succeeded" | "failed";
  readonly failureKind?: "execution_failed";
  readonly failureReasonCode?: string;
} {
  const result = output && typeof output === "object" && !Array.isArray(output)
    ? output as Record<string, unknown> : null;
  let reason: string | undefined;
  if (toolName === "run_command") {
    if (!result) reason = "command_result_unverified";
    else if (result.timedOut === true) reason = "command_timed_out";
    else if (typeof result.exitCode === "number" && result.exitCode !== 0) reason = "command_exit_nonzero";
    else if (result.success === false) reason = "command_execution_failed";
    else if (result.exitCode !== 0) reason = "command_result_unverified";
    else {
      const command = String(args.command || "");
      const unity = unityValidationInvocations(command);
      const review = authority as { expectedTestCases?: number; useProjectEditor?: true } | undefined;
      if (review?.useProjectEditor) {
        const filter = projectEditorPlayModeFilter(command);
        if (!filter || !verifiedProjectEditorPlayModeResult(filter, result, review.expectedTestCases)) reason = "unity_validation_verdict_unverified";
      } else if (unity.length > 0 && !verifiedUnityValidationResult(unity, result, review?.expectedTestCases)) {
        reason = "unity_validation_verdict_unverified";
      } else if (unity.length === 0 && isUnmanagedUnityVerification(command)) {
        reason = "unity_validation_verdict_unverified";
      }
    }
  } else if (toolName === "browser_evaluate" && result?.ok === false) {
    reason = "browser_execution_failed";
  } else if (toolName === "unity_create_scene" && (result?.success !== true ||
    typeof result.version !== "string" || !/^sha256-[a-f\d]{64}$/.test(result.version))) {
    reason = "unity_scene_result_unverified";
  }
  return reason ? { status: "failed", failureKind: "execution_failed", failureReasonCode: reason }
    : { status: "succeeded" };
}
