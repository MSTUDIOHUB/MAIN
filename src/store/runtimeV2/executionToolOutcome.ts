/** Interpret only the native result contract owned by this tool. User file
 * content, MCP payloads and diagnostic prose do not carry execution status. */
export function runtimeV2StructuredToolOutcome(toolName: string, output: unknown): {
  readonly status: "succeeded" | "failed";
  readonly failureKind?: "execution_failed";
  readonly failureReasonCode?: string;
} {
  const result = output && typeof output === "object" && !Array.isArray(output)
    ? output as Record<string, unknown> : null;
  let reason: string | undefined;
  if (toolName === "run_command" && result) {
    if (result.timedOut === true) reason = "command_timed_out";
    else if (typeof result.exitCode === "number" && result.exitCode !== 0) reason = "command_exit_nonzero";
    else if (result.success === false) reason = "command_execution_failed";
  } else if (toolName === "browser_evaluate" && result?.ok === false) {
    reason = "browser_execution_failed";
  }
  return reason ? { status: "failed", failureKind: "execution_failed", failureReasonCode: reason }
    : { status: "succeeded" };
}
